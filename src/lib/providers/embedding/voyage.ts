import type { EmbeddingProvider } from "../types";
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly id = "voyage";
  readonly dimensions = 1024;
  readonly model = "voyage-3-large";
  async embed(_input: string | string[]): Promise<number[][]> { throw new Error("Voyage embedding: not implemented yet"); }
}
