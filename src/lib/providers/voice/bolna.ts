import type {
  VoiceProvider,
  VoiceAssistantConfig,
  WebhookResponse,
} from "../types";

// ============================================================
// Bolna Voice Provider (India-native alternative)
// ============================================================
// Best for: Indian phone numbers (+91), Hindi, <300ms latency
// Set VOICE_PROVIDER=bolna in .env.local to activate.
// ============================================================

export class BolnaVoiceProvider implements VoiceProvider {
  readonly id = "bolna";

  private get apiKey(): string {
    const key = process.env.BOLNA_API_KEY;
    if (!key) throw new Error("BOLNA_API_KEY is required");
    return key;
  }

  async createAssistant(config: VoiceAssistantConfig): Promise<{ assistantId: string }> {
    const res = await fetch("https://api.bolna.dev/v1/agent", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: config.name,
        llm: {
          provider: "openai",
          model: "gpt-4o-mini",
          system_prompt: config.systemPrompt,
          temperature: 0.7,
        },
        tts: {
          provider: "elevenlabs",
          voice_id: config.voiceId || "pNInz6obpgDQGcFmaJgB",
          model: "eleven_turbo_v2_5",
        },
        stt: {
          provider: "deepgram",
          model: "nova-2",
          language: config.language === "hi" ? "hi" : "multi",
        },
        telephony: {
          provider: "plivo", // India-native telephony
        },
        first_message: config.firstMessage,
        tools: config.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          webhook_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/voice/webhook`,
        })),
      }),
    });

    if (!res.ok) throw new Error(`Bolna API error: ${await res.text()}`);
    const data = await res.json();
    return { assistantId: data.agent_id };
  }

  async getWebToken(): Promise<string> {
    // Bolna uses agent_id directly for web SDK
    return process.env.BOLNA_AGENT_ID || "";
  }

  async getPhoneNumber(): Promise<string | null> {
    // Bolna assigns Indian numbers via their dashboard
    // Returns the assigned +91 number
    if (!process.env.BOLNA_AGENT_ID) return null;

    const res = await fetch(
      `https://api.bolna.dev/v1/agent/${process.env.BOLNA_AGENT_ID}`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      }
    );

    if (!res.ok) return null;
    const data = await res.json();
    return data.phone_number || null;
  }

  async handleWebhook(payload: unknown): Promise<WebhookResponse> {
    const data = payload as Record<string, unknown>;
    const event = data.event || data.type;

    if (event === "tool_call") {
      return {
        type: "tool_call",
        data: { toolCalls: data.tool_calls || [] },
      };
    }

    if (event === "call_ended") {
      return { type: "end_of_call", data: data as Record<string, unknown> };
    }

    return { type: "unknown", data: data as Record<string, unknown> };
  }
}
