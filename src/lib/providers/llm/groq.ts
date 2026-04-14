import type { LLMProvider, LLMMessage, LLMStreamOptions } from "../types";

export class GroqLLMProvider implements LLMProvider {
  readonly id = "groq";

  private get apiKey(): string {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error("GROQ_API_KEY is required");
    return key;
  }

  async streamChat(messages: LLMMessage[], options?: LLMStreamOptions): Promise<ReadableStream> {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options?.model || "llama-3.3-70b-versatile",
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens || 1024,
        stream: true,
      }),
    });

    if (!res.ok) throw new Error(`Groq API error: ${await res.text()}`);
    return res.body!;
  }

  async complete(messages: LLMMessage[], options?: LLMStreamOptions): Promise<string> {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options?.model || "llama-3.3-70b-versatile",
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens || 1024,
      }),
    });

    if (!res.ok) throw new Error(`Groq API error: ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content;
  }
}
