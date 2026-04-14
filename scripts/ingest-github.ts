#!/usr/bin/env npx tsx
/**
 * GitHub Auto-Ingestion Script
 *
 * Fetches READMEs, docs, and key files from all user repos,
 * converts them to structured markdown, and writes to /data/
 * for the main ingestion pipeline to embed.
 *
 * Usage:
 *   npx tsx scripts/ingest-github.ts
 *   npx tsx scripts/ingest-github.ts --include-private
 *   npx tsx scripts/ingest-github.ts --repos test-platform,DeepSkill
 *
 * Prerequisites:
 *   - `gh` CLI authenticated (gh auth login)
 *   - OR GITHUB_TOKEN env var set
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";

const DATA_DIR = resolve(process.cwd(), "data", "github");

interface GitHubRepo {
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  topics: string[];
  isPrivate: boolean;
  isFork: boolean;
  stargazerCount: number;
  url: string;
  defaultBranch: string;
  pushedAt: string;
}

interface RepoFile {
  path: string;
  content: string;
}

// --------------- GitHub API helpers ---------------

function gh(args: string): string {
  try {
    return execSync(`gh ${args}`, {
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[GitHub] gh command failed: ${msg}`);
    return "";
  }
}

function fetchRepos(includePrivate: boolean, filterRepos?: string[]): GitHubRepo[] {
  const visibility = includePrivate ? "" : "--visibility public";
  const json = gh(
    `repo list --json name,description,primaryLanguage,repositoryTopics,isPrivate,isFork,stargazerCount,url,defaultBranchRef,pushedAt --limit 100 ${visibility}`
  );

  if (!json) {
    console.error("[GitHub] Failed to list repos. Is `gh` authenticated?");
    process.exit(1);
  }

  const repos = JSON.parse(json) as {
    name: string;
    description: string | null;
    primaryLanguage: { name: string } | null;
    repositoryTopics: { name: string }[];
    isPrivate: boolean;
    isFork: boolean;
    stargazerCount: number;
    url: string;
    defaultBranchRef: { name: string } | null;
    pushedAt: string;
  }[];

  return repos
    .filter((r) => !r.isFork) // Skip forks
    .filter((r) => !filterRepos || filterRepos.includes(r.name))
    .map((r) => ({
      name: r.name,
      fullName: r.url.replace("https://github.com/", ""),
      description: r.description,
      language: r.primaryLanguage?.name || null,
      topics: r.repositoryTopics?.map((t) => t.name) || [],
      isPrivate: r.isPrivate,
      isFork: r.isFork,
      stargazerCount: r.stargazerCount,
      url: r.url,
      defaultBranch: r.defaultBranchRef?.name || "main",
      pushedAt: r.pushedAt,
    }));
}

function fetchFile(repo: string, path: string): string | null {
  const content = gh(`api repos/${repo}/contents/${path} --jq .content 2>/dev/null`);
  if (!content) return null;
  try {
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf-8");
  } catch {
    return null;
  }
}

function fetchTreeFiles(repo: string, branch: string, patterns: string[]): RepoFile[] {
  // Get the full tree
  const treeJson = gh(
    `api repos/${repo}/git/trees/${branch}?recursive=1 --jq '.tree[] | select(.type == "blob") | .path'`
  );
  if (!treeJson) return [];

  const allPaths = treeJson.split("\n").filter(Boolean);
  const matched: RepoFile[] = [];

  for (const filePath of allPaths) {
    const lowerPath = filePath.toLowerCase();
    const shouldFetch = patterns.some((p) => {
      if (p.startsWith("*")) return lowerPath.endsWith(p.slice(1));
      return lowerPath.includes(p);
    });

    if (shouldFetch) {
      const content = fetchFile(repo, filePath);
      if (content && content.length > 50) {
        matched.push({ path: filePath, content });
      }
    }
  }

  return matched;
}

// --------------- Markdown generation ---------------

function generateRepoMarkdown(repo: GitHubRepo, files: RepoFile[]): string {
  const lines: string[] = [];

  lines.push(`## ${repo.name}`);
  lines.push(`**Repo:** ${repo.name}`);
  if (repo.description) lines.push(`**Description:** ${repo.description}`);
  if (repo.language) lines.push(`**Primary Language:** ${repo.language}`);
  if (repo.topics.length > 0) lines.push(`**Topics:** ${repo.topics.join(", ")}`);
  lines.push(`**Stars:** ${repo.stargazerCount}`);
  lines.push(`**Last Updated:** ${new Date(repo.pushedAt).toLocaleDateString("en-IN")}`);
  if (!repo.isPrivate) lines.push(`**URL:** ${repo.url}`);
  lines.push("");

  // README content
  const readme = files.find((f) => f.path.toLowerCase() === "readme.md");
  if (readme) {
    lines.push("### README");
    lines.push("");
    // Trim very long READMEs but keep enough for RAG
    const trimmedReadme = readme.content.length > 8000
      ? readme.content.slice(0, 8000) + "\n\n[...truncated for brevity]"
      : readme.content;
    lines.push(trimmedReadme);
    lines.push("");
  }

  // Other doc files
  const docs = files.filter((f) => f.path.toLowerCase() !== "readme.md");
  for (const doc of docs) {
    lines.push(`### ${doc.path}`);
    lines.push("");
    const trimmed = doc.content.length > 4000
      ? doc.content.slice(0, 4000) + "\n\n[...truncated]"
      : doc.content;
    lines.push(trimmed);
    lines.push("");
  }

  return lines.join("\n");
}

// --------------- Main ---------------

async function main() {
  const args = process.argv.slice(2);
  const includePrivate = args.includes("--include-private");
  const reposFlag = args.find((a) => a.startsWith("--repos="));
  const filterRepos = reposFlag ? reposFlag.split("=")[1].split(",") : undefined;

  console.log("=== GitHub Auto-Ingestion ===\n");
  console.log(`Include private repos: ${includePrivate}`);
  if (filterRepos) console.log(`Filter repos: ${filterRepos.join(", ")}`);

  // Fetch repos
  const repos = fetchRepos(includePrivate, filterRepos);
  console.log(`\nFound ${repos.length} repos (excluding forks)\n`);

  if (repos.length === 0) {
    console.log("No repos to process.");
    return;
  }

  // Ensure output directory
  mkdirSync(DATA_DIR, { recursive: true });

  // Files to look for in each repo
  const docPatterns = [
    "readme.md",
    "docs/",
    "doc/",
    "architecture.md",
    "contributing.md",
    "changelog.md",
    "design.md",
    "*.md",  // any markdown in root
  ];

  const allRepoMarkdown: string[] = [];
  allRepoMarkdown.push("# GitHub Projects\n");
  allRepoMarkdown.push("Auto-generated from GitHub repos. Do NOT edit manually — re-run `npx tsx scripts/ingest-github.ts` to update.\n");

  for (const repo of repos) {
    console.log(`[${repo.name}] Fetching docs...`);

    // Fetch relevant files
    const files = fetchTreeFiles(repo.fullName, repo.defaultBranch, docPatterns);
    console.log(`[${repo.name}] Found ${files.length} doc files`);

    if (files.length === 0) {
      // At minimum, try just the README directly
      const readme = fetchFile(repo.fullName, "README.md");
      if (readme) {
        files.push({ path: "README.md", content: readme });
        console.log(`[${repo.name}] Fetched README directly`);
      }
    }

    const repoMd = generateRepoMarkdown(repo, files);
    allRepoMarkdown.push(repoMd);

    // Also write individual repo file for targeted ingestion
    const repoFile = join(DATA_DIR, `${repo.name}.md`);
    writeFileSync(repoFile, `# ${repo.name}\n\n${repoMd}`, "utf-8");
    console.log(`[${repo.name}] Wrote ${repoFile}\n`);
  }

  // Write combined projects file (replaces the template in /data/projects.md)
  const combinedFile = resolve(process.cwd(), "data", "projects.md");
  writeFileSync(combinedFile, allRepoMarkdown.join("\n---\n\n"), "utf-8");
  console.log(`\n=== Done ===`);
  console.log(`Combined projects file: ${combinedFile}`);
  console.log(`Individual repo files: ${DATA_DIR}/`);
  console.log(`\nNext: run \`npx tsx scripts/ingest.ts\` to embed and upsert.`);
}

main().catch((err) => {
  console.error("GitHub ingestion failed:", err);
  process.exit(1);
});
