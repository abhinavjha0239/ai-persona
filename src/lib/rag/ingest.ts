import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname, basename } from "path";
import type { VectorDocument } from "@/lib/providers/types";

// ============================================================
// Knowledge Base Ingestion Pipeline
// ============================================================
// Reads markdown files from /data/, chunks them, embeds, and
// upserts into the configured vector store.
//
// Chunking strategy: split by headings (##) and paragraphs,
// keeping chunks between 200-800 tokens for optimal retrieval.
// ============================================================

const MAX_CHUNK_CHARS = 1500;
const MIN_CHUNK_CHARS = 100;
const OVERLAP_CHARS = 150;

interface ChunkedDocument {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

/**
 * Load all markdown files from a directory recursively.
 */
export function loadMarkdownFiles(dir: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...loadMarkdownFiles(fullPath));
    } else if (extname(entry) === ".md") {
      files.push({
        path: fullPath,
        content: readFileSync(fullPath, "utf-8"),
      });
    }
  }

  return files;
}

/**
 * Chunk a markdown document by headings and paragraphs.
 * Maintains heading context in each chunk for better retrieval.
 */
export function chunkMarkdown(
  content: string,
  filePath: string
): ChunkedDocument[] {
  const source = basename(filePath, ".md");
  const chunks: ChunkedDocument[] = [];

  // Split by level-2 headings (##) as primary sections
  const sections = content.split(/^## /m);
  let currentHeading = "";

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].trim();
    if (!section) continue;

    // First section might be the file header (# Title) or preamble
    if (i === 0) {
      const titleMatch = section.match(/^# (.+)/m);
      if (titleMatch) {
        currentHeading = titleMatch[1].trim();
      }
      // If the preamble has substantial content, chunk it
      const preambleContent = section.replace(/^# .+\n/, "").trim();
      if (preambleContent.length >= MIN_CHUNK_CHARS) {
        chunks.push(...splitLargeSection(preambleContent, source, currentHeading, chunks.length));
      }
      continue;
    }

    // Extract heading from section
    const lines = section.split("\n");
    const heading = lines[0].trim();
    const body = lines.slice(1).join("\n").trim();

    if (!body || body.length < MIN_CHUNK_CHARS) {
      // Small section — include heading + body as one chunk
      if (body) {
        const fullContent = `## ${heading}\n\n${body}`;
        chunks.push({
          id: `${source}-${chunks.length}`,
          content: fullContent,
          metadata: {
            source,
            section: heading,
            type: inferType(source, heading),
            technologies: extractTechKeywords(fullContent),
          },
        });
      }
      continue;
    }

    // Large section — split further by paragraphs
    chunks.push(...splitLargeSection(
      `## ${heading}\n\n${body}`,
      source,
      heading,
      chunks.length
    ));
  }

  return chunks;
}

function splitLargeSection(
  content: string,
  source: string,
  section: string,
  startIndex: number
): ChunkedDocument[] {
  const chunks: ChunkedDocument[] = [];
  const baseType = inferType(source, section);

  if (content.length <= MAX_CHUNK_CHARS) {
    chunks.push({
      id: `${source}-${startIndex}`,
      content,
      metadata: { source, section, type: baseType, technologies: extractTechKeywords(content) },
    });
    return chunks;
  }

  // Split by double newlines (paragraphs)
  const paragraphs = content.split(/\n\n+/);
  let currentChunk = "";

  for (const para of paragraphs) {
    if (currentChunk.length + para.length + 2 > MAX_CHUNK_CHARS && currentChunk.length >= MIN_CHUNK_CHARS) {
      const trimmed = currentChunk.trim();
      chunks.push({
        id: `${source}-${startIndex + chunks.length}`,
        content: trimmed,
        metadata: { source, section, type: baseType, technologies: extractTechKeywords(trimmed) },
      });
      // Overlap: keep the last bit of context
      const overlapStart = currentChunk.length - OVERLAP_CHARS;
      currentChunk = overlapStart > 0 ? currentChunk.slice(overlapStart) + "\n\n" + para : para;
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + para;
    }
  }

  // Flush remaining
  if (currentChunk.trim().length >= MIN_CHUNK_CHARS) {
    const trimmed = currentChunk.trim();
    chunks.push({
      id: `${source}-${startIndex + chunks.length}`,
      content: trimmed,
      metadata: { source, section, type: baseType, technologies: extractTechKeywords(trimmed) },
    });
  }

  return chunks;
}

/**
 * Infer the document type from source filename and section heading.
 * Used for metadata tagging and filtered retrieval.
 */
function inferType(source: string, section: string): string {
  const s = `${source} ${section}`.toLowerCase();
  if (s.includes("project") || s.includes("repo") || s.includes("github")) return "project";
  if (s.includes("experience") || s.includes("work") || s.includes("company")) return "experience";
  if (s.includes("education") || s.includes("degree") || s.includes("university")) return "education";
  if (s.includes("skill") || s.includes("tech") || s.includes("stack")) return "skills";
  if (s.includes("about") || s.includes("summary") || s.includes("intro")) return "about";
  if (s.includes("role") || s.includes("fit") || s.includes("why")) return "fit";
  if (s.includes("architecture") || s.includes("design") || s.includes("tradeoff")) return "architecture";
  if (s.includes("readme") || s.includes("overview")) return "overview";
  return "general";
}

/**
 * Extract tech stack keywords from content for metadata enrichment.
 */
function extractTechKeywords(content: string): string[] {
  const techPatterns = [
    /\b(typescript|javascript|python|go|golang|rust|java|c\+\+|ruby|swift|kotlin)\b/gi,
    /\b(react|next\.?js|vue|angular|svelte|express|fastapi|django|flask|spring)\b/gi,
    /\b(docker|kubernetes|k8s|aws|gcp|azure|vercel|heroku)\b/gi,
    /\b(postgresql|mysql|mongodb|redis|supabase|firebase|dynamodb|sqlite)\b/gi,
    /\b(graphql|grpc|rest|websocket)\b/gi,
    /\b(pytorch|tensorflow|langchain|llamaindex|openai)\b/gi,
    /\b(rag|llm|nlp|embeddings?|vector|transformer)\b/gi,
  ];
  const keywords = new Set<string>();
  for (const pattern of techPatterns) {
    for (const m of content.matchAll(pattern)) {
      keywords.add(m[0].toLowerCase());
    }
  }
  return [...keywords];
}

/**
 * Full ingestion pipeline: load files → chunk → embed → upsert.
 * Run this as a script before deploying.
 */
export async function ingestKnowledgeBase(
  dataDir: string,
  embedder: { embed: (input: string | string[]) => Promise<number[][]> },
  vectorStore: { upsert: (docs: VectorDocument[]) => Promise<void>; delete: (ids: string[]) => Promise<void> }
): Promise<{ totalChunks: number; totalFiles: number }> {
  const files = loadMarkdownFiles(dataDir);
  console.log(`[Ingest] Found ${files.length} markdown files`);

  const allChunks: ChunkedDocument[] = [];
  for (const file of files) {
    const chunks = chunkMarkdown(file.content, file.path);
    allChunks.push(...chunks);
    console.log(`[Ingest] ${basename(file.path)}: ${chunks.length} chunks`);
  }

  if (allChunks.length === 0) {
    console.log("[Ingest] No chunks to ingest");
    return { totalChunks: 0, totalFiles: files.length };
  }

  // Embed all chunks — use single call where possible, fall back to batches
  const documents: VectorDocument[] = [];
  const allTexts = allChunks.map((c) => c.content);

  console.log(`[Ingest] Embedding ${allTexts.length} chunks...`);

  let allEmbeddings: number[][];
  try {
    // Try single batch (avoids multiple API calls hitting rate limits)
    allEmbeddings = await embedder.embed(allTexts);
    console.log(`[Ingest] Embedded all ${allTexts.length} chunks in single call`);
  } catch (singleErr) {
    // Fall back to small batches with delays
    console.log(`[Ingest] Single batch failed, falling back to small batches with delays`);
    allEmbeddings = [];
    const BATCH_SIZE = 5;

    for (let i = 0; i < allTexts.length; i += BATCH_SIZE) {
      const batchTexts = allTexts.slice(i, i + BATCH_SIZE);

      let embeddings: number[][] | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          embeddings = await embedder.embed(batchTexts);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("429") && attempt < 4) {
            const wait = Math.min((attempt + 1) * 60, 180);
            console.log(`[Ingest] Rate limited (attempt ${attempt + 1}), waiting ${wait}s...`);
            await new Promise((r) => setTimeout(r, wait * 1000));
          } else {
            throw err;
          }
        }
      }
      if (!embeddings) throw new Error("Failed to embed after retries");
      allEmbeddings.push(...embeddings);

      console.log(`[Ingest] Embedded batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allTexts.length / BATCH_SIZE)}`);
      if (i + BATCH_SIZE < allTexts.length) {
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }

  for (let j = 0; j < allChunks.length; j++) {
    documents.push({
      id: allChunks[j].id,
      content: allChunks[j].content,
      embedding: allEmbeddings[j],
      metadata: allChunks[j].metadata,
    });
  }

  // Upsert all documents
  await vectorStore.upsert(documents);
  console.log(`[Ingest] Upserted ${documents.length} documents to vector store`);

  return { totalChunks: documents.length, totalFiles: files.length };
}
