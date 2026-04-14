import type { VectorStoreProvider, VectorDocument, VectorSearchResult } from "../types";
export class ChromaVectorStore implements VectorStoreProvider {
  readonly id = "chroma";
  async upsert(_documents: VectorDocument[]): Promise<void> { throw new Error("Chroma: not implemented yet"); }
  async search(_query: number[], _topK?: number): Promise<VectorSearchResult[]> { throw new Error("Chroma: not implemented yet"); }
  async delete(_ids: string[]): Promise<void> { throw new Error("Chroma: not implemented yet"); }
}
