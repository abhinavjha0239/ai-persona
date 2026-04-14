import type { EmbeddingProvider } from "../types";

export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "azure-openai";
  readonly dimensions = 1536;
  readonly model = "text-embedding-3-small";

  private get resourceName(): string {
    const name = process.env.AZURE_OPENAI_RESOURCE_NAME;
    if (!name) throw new Error("AZURE_OPENAI_RESOURCE_NAME is required");
    return name;
  }

  private get apiKey(): string {
    const key = process.env.AZURE_OPENAI_API_KEY;
    if (!key) throw new Error("AZURE_OPENAI_API_KEY is required");
    return key;
  }

  private get deployment(): string {
    return process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || "text-embedding-3-small";
  }

  async embed(input: string | string[]): Promise<number[][]> {
    const texts = Array.isArray(input) ? input : [input];

    const res = await fetch(
      `https://${this.resourceName}.openai.azure.com/openai/deployments/${this.deployment}/embeddings?api-version=2024-06-01`,
      {
        method: "POST",
        headers: {
          "api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: texts }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Azure OpenAI embedding error (${res.status}): ${body}`);
    }

    const data: { data: { embedding: number[] }[] } = await res.json();
    return data.data.map((d) => d.embedding);
  }
}
