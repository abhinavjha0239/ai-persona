import type { EmbeddingProvider } from "../types";
export class CohereEmbeddingProvider implements EmbeddingProvider {
  readonly id = "cohere";
  readonly dimensions = 1024;
  readonly model = "embed-english-v3.0";
  async embed(_input: string | string[]): Promise<number[][]> { throw new Error("Cohere embedding: not implemented yet"); }
}
