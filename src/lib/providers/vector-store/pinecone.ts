import type { VectorStoreProvider, VectorDocument, VectorSearchResult } from "../types";
export class PineconeVectorStore implements VectorStoreProvider {
  readonly id = "pinecone";
  async upsert(_documents: VectorDocument[]): Promise<void> { throw new Error("Pinecone: not implemented yet"); }
  async search(_query: number[], _topK?: number): Promise<VectorSearchResult[]> { throw new Error("Pinecone: not implemented yet"); }
  async delete(_ids: string[]): Promise<void> { throw new Error("Pinecone: not implemented yet"); }
}
