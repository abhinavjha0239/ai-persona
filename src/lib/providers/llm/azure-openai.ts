import type { LLMProvider, LLMMessage, LLMStreamOptions } from "../types";

export class AzureOpenAILLMProvider implements LLMProvider {
  readonly id = "azure-openai";

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
    return process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || "gpt-5-4-mini";
  }

  async streamChat(messages: LLMMessage[], options?: LLMStreamOptions): Promise<ReadableStream> {
    const { streamText } = await import("ai");
    const { createAzure } = await import("@ai-sdk/azure");

    const azure = createAzure({
      resourceName: this.resourceName,
      apiKey: this.apiKey,
    });

    const result = streamText({
      model: azure(options?.model || this.deployment),
      messages: messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      })),
      temperature: options?.temperature ?? 0.7,
      maxOutputTokens: options?.maxTokens,
    });

    return (await result).textStream as unknown as ReadableStream;
  }

  async complete(messages: LLMMessage[], options?: LLMStreamOptions): Promise<string> {
    const { generateText } = await import("ai");
    const { createAzure } = await import("@ai-sdk/azure");

    const azure = createAzure({
      resourceName: this.resourceName,
      apiKey: this.apiKey,
    });

    const result = await generateText({
      model: azure(options?.model || this.deployment),
      messages: messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      })),
      temperature: options?.temperature ?? 0.7,
      maxOutputTokens: options?.maxTokens,
    });

    return result.text;
  }
}
