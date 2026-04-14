import type {
  VoiceProvider,
  VoiceAssistantConfig,
  WebhookResponse,
} from "../types";

// ============================================================
// Retell Voice Provider (Swap-in alternative to Vapi)
// ============================================================
// Set VOICE_PROVIDER=retell in .env.local to activate.
// ============================================================

export class RetellVoiceProvider implements VoiceProvider {
  readonly id = "retell";

  async createAssistant(config: VoiceAssistantConfig): Promise<{ assistantId: string }> {
    const apiKey = process.env.RETELL_API_KEY;
    if (!apiKey) throw new Error("RETELL_API_KEY is required");

    const res = await fetch("https://api.retellai.com/v2/create-agent", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_name: config.name,
        response_engine: {
          type: "retell-llm",
          llm_id: undefined, // Created separately via Retell dashboard
        },
        voice_id: config.voiceId || "11labs-Adrian",
        language: config.language === "hi" ? "hindi" : "english",
        begin_message: config.firstMessage,
        enable_backchannel: true,
        interruption_sensitivity: 0.8,
        ambient_sound: null,
      }),
    });

    if (!res.ok) throw new Error(`Retell API error: ${await res.text()}`);
    const data = await res.json();
    return { assistantId: data.agent_id };
  }

  async getWebToken(): Promise<string> {
    const apiKey = process.env.RETELL_API_KEY;
    if (!apiKey) throw new Error("RETELL_API_KEY is required");

    const res = await fetch("https://api.retellai.com/v2/create-web-call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: process.env.RETELL_AGENT_ID,
      }),
    });

    if (!res.ok) throw new Error(`Retell token error: ${await res.text()}`);
    const data = await res.json();
    return data.access_token;
  }

  async getPhoneNumber(): Promise<string | null> {
    // Retell phone numbers are managed via dashboard
    return null;
  }

  async handleWebhook(payload: unknown): Promise<WebhookResponse> {
    const data = payload as Record<string, unknown>;

    if (data.event === "call_ended") {
      return { type: "end_of_call", data: data as Record<string, unknown> };
    }

    if (data.event === "function_call") {
      return {
        type: "tool_call",
        data: {
          toolCalls: [
            {
              name: (data as Record<string, unknown>).function_name,
              arguments: (data as Record<string, unknown>).arguments,
            },
          ],
        },
      };
    }

    return { type: "unknown", data: data as Record<string, unknown> };
  }
}
