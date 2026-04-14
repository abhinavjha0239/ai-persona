import type { LLMProvider, LLMMessage, LLMStreamOptions } from "../types";

export class GoogleLLMProvider implements LLMProvider {
  readonly id = "google";

  async streamChat(messages: LLMMessage[], options?: LLMStreamOptions): Promise<ReadableStream> {
    const { streamText } = await import("ai");
    const { google } = await import("@ai-sdk/google");
    
    const result = streamText({
      model: google(options?.model || "gemini-2.5-flash"),
      messages: messages.map(m => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
      temperature: options?.temperature ?? 0.7,
      maxOutputTokens: options?.maxTokens,
    });
    
    return (await result).textStream as unknown as ReadableStream;
  }

  async complete(messages: LLMMessage[], options?: LLMStreamOptions): Promise<string> {
    const { generateText } = await import("ai");
    const { google } = await import("@ai-sdk/google");
    
    const result = await generateText({
      model: google(options?.model || "gemini-2.5-flash"),
      messages: messages.map(m => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
      temperature: options?.temperature ?? 0.7,
      maxOutputTokens: options?.maxTokens,
    });
    
    return result.text;
  }
}
