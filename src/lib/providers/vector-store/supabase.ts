import type { VectorStoreProvider, VectorDocument, VectorSearchResult } from "../types";
import { createClient } from "@supabase/supabase-js";

export class SupabaseVectorStore implements VectorStoreProvider {
  readonly id = "supabase";

  private get client() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");
    return createClient(url, key);
  }

  async upsert(documents: VectorDocument[]): Promise<void> {
    const rows = documents.map(doc => ({
      id: doc.id,
      content: doc.content,
      embedding: doc.embedding,
      metadata: doc.metadata,
    }));
    const { error } = await this.client.from("documents").upsert(rows);
    if (error) throw new Error(`Supabase upsert error: ${error.message}`);
  }

  async search(query: number[], topK = 5, _filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
    const { data, error } = await this.client.rpc("match_documents", {
      query_embedding: query,
      match_threshold: 0.7,
      match_count: topK,
    });
    if (error) throw new Error(`Supabase search error: ${error.message}`);
    return (data || []).map((row: { id: string; content: string; metadata: Record<string, unknown>; similarity: number }) => ({
      id: row.id,
      content: row.content,
      metadata: row.metadata || {},
      similarity: row.similarity,
    }));
  }

  async delete(ids: string[]): Promise<void> {
    const { error } = await this.client.from("documents").delete().in("id", ids);
    if (error) throw new Error(`Supabase delete error: ${error.message}`);
  }
}
