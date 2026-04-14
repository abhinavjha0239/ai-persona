import type { LLMProvider, LLMMessage, LLMStreamOptions } from "../types";

export class AnthropicLLMProvider implements LLMProvider {
  readonly id = "anthropic";

  async streamChat(messages: LLMMessage[], options?: LLMStreamOptions): Promise<ReadableStream> {
    const { streamText } = await import("ai");
    const { anthropic } = await import("@ai-sdk/anthropic");
    
    const result = streamText({
      model: anthropic(options?.model || "claude-sonnet-4-5-20250929"),
      messages: messages.map(m => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
      temperature: options?.temperature ?? 0.7,
      maxOutputTokens: options?.maxTokens || 1024,
    });

    return (await result).textStream as unknown as ReadableStream;
  }

  async complete(messages: LLMMessage[], options?: LLMStreamOptions): Promise<string> {
    const { generateText } = await import("ai");
    const { anthropic } = await import("@ai-sdk/anthropic");

    const result = await generateText({
      model: anthropic(options?.model || "claude-sonnet-4-5-20250929"),
      messages: messages.map(m => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
      temperature: options?.temperature ?? 0.7,
      maxOutputTokens: options?.maxTokens || 1024,
    });
    
    return result.text;
  }
}
