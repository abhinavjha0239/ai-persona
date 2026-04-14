import type { LLMProvider, LLMMessage, LLMStreamOptions } from "../types";

export class OpenAILLMProvider implements LLMProvider {
  readonly id = "openai";

  async streamChat(messages: LLMMessage[], options?: LLMStreamOptions): Promise<ReadableStream> {
    const { streamText } = await import("ai");
    const { openai } = await import("@ai-sdk/openai");
    
    const result = streamText({
      model: openai(options?.model || "gpt-4o-mini"),
      messages: messages.map(m => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
      temperature: options?.temperature ?? 0.7,
      maxOutputTokens: options?.maxTokens,
    });
    
    return (await result).textStream as unknown as ReadableStream;
  }

  async complete(messages: LLMMessage[], options?: LLMStreamOptions): Promise<string> {
    const { generateText } = await import("ai");
    const { openai } = await import("@ai-sdk/openai");
    
    const result = await generateText({
      model: openai(options?.model || "gpt-4o-mini"),
      messages: messages.map(m => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
      temperature: options?.temperature ?? 0.7,
      maxOutputTokens: options?.maxTokens,
    });
    
    return result.text;
  }
}
