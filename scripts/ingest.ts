#!/usr/bin/env npx tsx
/**
 * Knowledge Base Ingestion Script
 *
 * Reads markdown files from /data/ (including /data/github/ for
 * auto-ingested repos), chunks them, embeds with the configured
 * provider, and upserts to the vector store.
 *
 * Usage:
 *   npx tsx scripts/ingest.ts                    # Ingest all
 *   npx tsx scripts/ingest-github.ts             # Pull from GitHub first
 *   npx tsx scripts/ingest.ts                    # Then embed + upsert
 *
 * Prerequisites:
 *   - .env.local with Azure OpenAI or OpenAI API keys
 *   - .env.local with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   - Markdown files in /data/ directory
 *   - Supabase table + function created (see scripts/setup-supabase.sql)
 */

import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables
config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const dataDir = resolve(process.cwd(), "data");

  // Dynamic imports after env is loaded
  const { ingestKnowledgeBase } = await import("../src/lib/rag/ingest");
  const { getEmbeddingProvider, getVectorStoreProvider } = await import(
    "../src/lib/providers/registry"
  );

  console.log("=== Knowledge Base Ingestion ===\n");

  const embedder = await getEmbeddingProvider();
  const vectorStore = await getVectorStoreProvider();

  console.log(`Embedding provider: ${embedder.id} (${embedder.model}, ${embedder.dimensions}d)`);
  console.log(`Vector store: ${vectorStore.id}`);
  console.log(`Data directory: ${dataDir}\n`);

  const result = await ingestKnowledgeBase(dataDir, embedder, vectorStore);

  console.log(`\n=== Done ===`);
  console.log(`Files processed: ${result.totalFiles}`);
  console.log(`Chunks ingested: ${result.totalChunks}`);
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
