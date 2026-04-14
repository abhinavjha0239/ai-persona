import type { EmbeddingProvider } from "../types";

// ============================================================
// Google Embedding Provider (FREE tier)
// ============================================================
// Uses Google's text-embedding-004 via Generative AI API.
// 768 dimensions, free tier: 1500 req/day.
// Set GOOGLE_GENERATIVE_AI_API_KEY in .env.local
// ============================================================

export class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly id = "google";
  readonly dimensions = 768;
  readonly model = "text-embedding-004";

  private get apiKey(): string {
    const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!key) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY required for Google embeddings");
    return key;
  }

  async embed(input: string | string[]): Promise<number[][]> {
    const texts = Array.isArray(input) ? input : [input];

    // Google's batch embed endpoint
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
            taskType: "RETRIEVAL_DOCUMENT",
          })),
        }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google embedding error (${res.status}): ${body}`);
    }

    const data = await res.json();
    return data.embeddings.map((e: { values: number[] }) => e.values);
  }
}
