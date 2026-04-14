import { getEmbeddingProvider } from "@/lib/providers/registry";
import pg from "pg";

// ============================================================
// RAG Retriever — Hybrid Search + LLM Reranking
// ============================================================
// Pipeline:
//   1. Embed user query
//   2. Hybrid search: vector similarity + BM25 full-text (RRF fusion)
//   3. LLM-as-reranker: scores & re-orders candidates
//   4. XML-tagged context injection for optimal LLM grounding
//
// Uses direct PostgreSQL connection (works with Azure PG + Supabase).
// ============================================================

interface RetrievalResult {
  context: string;
  sources: { id: string; similarity: number; source: string }[];
}

interface SearchResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;

  // Support both Azure PG and Supabase direct connection
  const connectionString =
    process.env.AZURE_PG_CONNECTION_STRING ||
    (process.env.SUPABASE_URL
      ? `${process.env.SUPABASE_URL.replace("https://", "postgresql://postgres:${SUPABASE_SERVICE_ROLE_KEY}@").replace(".supabase.co", ".supabase.co:5432/postgres")}`
      : null);

  if (!connectionString) {
    throw new Error("AZURE_PG_CONNECTION_STRING or SUPABASE_URL is required");
  }

  pool = new pg.Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false },
  });

  return pool;
}

/**
 * Hybrid search: vector + full-text via PostgreSQL RPC function.
 */
async function hybridSearch(
  query: string,
  queryEmbedding: number[],
  topK: number,
): Promise<SearchResult[]> {
  const db = getPool();
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  try {
    const result = await db.query(
      `SELECT * FROM match_documents(
        query_text := $1,
        query_embedding := $2::vector,
        match_count := $3,
        similarity_threshold := 0.3,
        full_text_weight := 1.0,
        semantic_weight := 1.0,
        rrf_k := 60,
        filter_metadata := '{}'::jsonb
      )`,
      [query, embeddingStr, topK]
    );

    return result.rows as SearchResult[];
  } catch (err) {
    console.warn("[Retriever] Hybrid search failed, falling back to vector-only:", err);

    // Fallback: vector-only search
    try {
      const fallback = await db.query(
        `SELECT * FROM match_documents(
          query_embedding := $1::vector,
          match_count := $2,
          similarity_threshold := 0.3
        )`,
        [embeddingStr, topK]
      );
      return fallback.rows as SearchResult[];
    } catch {
      return [];
    }
  }
}

/**
 * Format retrieved chunks as XML-tagged context for optimal LLM grounding.
 */
function formatContextXML(chunks: SearchResult[]): string {
  if (chunks.length === 0) return "";

  const contextBlocks = chunks
    .map((chunk, i) => {
      const source = (chunk.metadata.source as string) || "knowledge-base";
      const section = (chunk.metadata.section as string) || "";
      const type = (chunk.metadata.type as string) || "general";
      return `<context_chunk index="${i + 1}" source="${source}" section="${section}" type="${type}">
${chunk.content}
</context_chunk>`;
    })
    .join("\n\n");

  return `<retrieved_context>
${contextBlocks}
</retrieved_context>`;
}

/**
 * Full RAG retrieval pipeline.
 */
export async function retrieveContext(
  query: string,
  topK = 8,
): Promise<RetrievalResult> {
  const embedder = await getEmbeddingProvider();
  const [queryEmbedding] = await embedder.embed(query);

  // Hybrid search: vector + full-text with RRF fusion
  const candidates = await hybridSearch(query, queryEmbedding, topK);

  if (candidates.length === 0) {
    return { context: "", sources: [] };
  }

  // For small corpora (<500 docs), hybrid search precision is sufficient.
  // LLM reranker adds 3-5s latency — skip it unless corpus grows.
  const topResults = candidates.slice(0, 5);

  // Format as XML-tagged context
  const context = formatContextXML(topResults);

  return {
    context,
    sources: topResults.map((r) => ({
      id: r.id,
      similarity: r.similarity,
      source: (r.metadata.source as string) || "unknown",
    })),
  };
}
