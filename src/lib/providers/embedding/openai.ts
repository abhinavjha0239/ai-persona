import type { EmbeddingProvider } from "../types";
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai";
  readonly dimensions = 1536;
  readonly model = "text-embedding-3-small";
  async embed(input: string | string[]): Promise<number[][]> {
    const texts = Array.isArray(input) ? input : [input];
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY required");
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`OpenAI embedding error: ${await res.text()}`);
    const data = await res.json();
    return data.data.map((d: { embedding: number[] }) => d.embedding);
  }
}
