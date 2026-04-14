import type { VectorStoreProvider, VectorDocument, VectorSearchResult } from "../types";
import pg from "pg";

// ============================================================
// Azure PostgreSQL + pgvector Vector Store Provider
// ============================================================
// Direct PostgreSQL connection to Azure Flexible Server.
// Uses the same hybrid search SQL as the Supabase provider
// but without the Supabase client dependency.
// ============================================================

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.AZURE_PG_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error(
      "AZURE_PG_CONNECTION_STRING is required. Format: " +
      "postgresql://user:pass@host.postgres.database.azure.com:5432/dbname?sslmode=require"
    );
  }

  pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false },
  });

  return pool;
}

export class AzurePgVectorStore implements VectorStoreProvider {
  readonly id = "azure-pg";

  async upsert(documents: VectorDocument[]): Promise<void> {
    const db = getPool();

    // Use a single transaction for all upserts
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      for (const doc of documents) {
        await client.query(
          `INSERT INTO documents (id, content, embedding, metadata)
           VALUES ($1, $2, $3::vector, $4::jsonb)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             embedding = EXCLUDED.embedding,
             metadata = EXCLUDED.metadata`,
          [
            doc.id,
            doc.content,
            `[${doc.embedding?.join(",")}]`,
            JSON.stringify(doc.metadata),
          ]
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async search(
    query: number[],
    topK = 5,
    filter?: Record<string, unknown>
  ): Promise<VectorSearchResult[]> {
    const db = getPool();
    const embeddingStr = `[${query.join(",")}]`;
    const filterJson = filter ? JSON.stringify(filter) : "{}";

    const result = await db.query(
      `SELECT * FROM match_documents(
        query_text := '',
        query_embedding := $1::vector,
        match_count := $2,
        similarity_threshold := 0.3,
        full_text_weight := 1.0,
        semantic_weight := 1.0,
        rrf_k := 60,
        filter_metadata := $3::jsonb
      )`,
      [embeddingStr, topK, filterJson]
    );

    return result.rows.map((row: { id: string; content: string; metadata: Record<string, unknown>; similarity: number }) => ({
      id: row.id,
      content: row.content,
      metadata: row.metadata || {},
      similarity: row.similarity,
    }));
  }

  async delete(ids: string[]): Promise<void> {
    const db = getPool();
    await db.query(
      "DELETE FROM documents WHERE id = ANY($1)",
      [ids]
    );
  }
}

/**
 * Direct hybrid search for the retriever module.
 * Bypasses the provider pattern for performance (single query).
 */
export async function azurePgHybridSearch(
  queryText: string,
  queryEmbedding: number[],
  topK: number,
): Promise<{ id: string; content: string; metadata: Record<string, unknown>; similarity: number }[]> {
  const db = getPool();
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

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
    [queryText, embeddingStr, topK]
  );

  return result.rows;
}
