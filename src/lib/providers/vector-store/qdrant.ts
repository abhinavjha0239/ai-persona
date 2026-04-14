import type { VectorStoreProvider, VectorDocument, VectorSearchResult } from "../types";
export class QdrantVectorStore implements VectorStoreProvider {
  readonly id = "qdrant";
  async upsert(_documents: VectorDocument[]): Promise<void> { throw new Error("Qdrant: not implemented yet"); }
  async search(_query: number[], _topK?: number): Promise<VectorSearchResult[]> { throw new Error("Qdrant: not implemented yet"); }
  async delete(_ids: string[]): Promise<void> { throw new Error("Qdrant: not implemented yet"); }
}
