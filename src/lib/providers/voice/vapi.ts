import type {
  VoiceProvider,
  VoiceAssistantConfig,
  WebhookResponse,
} from "../types";
import { env } from "@/lib/config/env";

// ============================================================
// Vapi Voice Provider
// ============================================================
// Handles assistant creation, web token auth, and webhooks.
// Vapi manages the full pipeline: STT → LLM → TTS
// We configure it and handle tool call webhooks.
// ============================================================

// Typed webhook payloads — no `any` needed
interface VapiWebhookMessage {
  type?: string;
  toolCalls?: Record<string, unknown>[];
  functionCall?: Record<string, unknown>;
  call?: Record<string, unknown>;
  summary?: string;
  endedReason?: string;
  transcript?: string;
  recordingUrl?: string;
  status?: string;
}

interface VapiWebhookPayload {
  type?: string;
  message?: VapiWebhookMessage;
}

interface VapiAssistant {
  id: string;
  name: string;
  model: {
    provider: string;
    model: string;
    messages: { role: string; content: string }[];
    tools: VapiTool[];
  };
  voice: {
    provider: string;
    voiceId: string;
  };
  transcriber: {
    provider: string;
    model: string;
    language?: string;
  };
  firstMessage: string;
  silenceTimeoutSeconds: number;
  maxDurationSeconds: number;
  backgroundSound: string;
  backchannelingEnabled: boolean;
  hipaaEnabled: boolean;
}

interface VapiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
  server?: {
    url: string;
  };
}

export class VapiVoiceProvider implements VoiceProvider {
  readonly id = "vapi";

  private get apiKey(): string {
    if (!env.VAPI_API_KEY) throw new Error("VAPI_API_KEY is required");
    return env.VAPI_API_KEY;
  }

  private get baseUrl(): string {
    return "https://api.vapi.ai";
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Vapi API error (${res.status}): ${body}`);
    }

    return res.json();
  }

  async createAssistant(config: VoiceAssistantConfig): Promise<{ assistantId: string }> {
    // Map our tool definitions to Vapi's format
    const vapiTools: VapiTool[] = config.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object" as const,
          properties: Object.fromEntries(
            Object.entries(tool.parameters).map(([key, param]) => [
              key,
              {
                type: param.type,
                description: param.description,
                ...(param.enum ? { enum: param.enum } : {}),
              },
            ])
          ),
          required: tool.required,
        },
      },
      server: {
        url: `${env.NEXT_PUBLIC_APP_URL}/api/voice/webhook`,
      },
    }));

    // Configure transcriber for Hindi+English
    const transcriber = this.getTranscriberConfig(config.language);

    // Configure voice for natural Indian English
    const voice = this.getVoiceConfig(config);

    const assistantPayload = {
      name: config.name,
      model: {
        provider: "custom-llm" as const,
        // Use Azure OpenAI gpt-4.1-mini — lowest latency for voice
        model: "azure-openai/gpt-4.1-mini",
        url: `https://${process.env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/deployments/${process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || "gpt-4.1-mini"}/chat/completions?api-version=2024-06-01`,
        messages: [{ role: "system", content: config.systemPrompt }],
        tools: vapiTools,
        temperature: 0.5,
        maxTokens: 250, // Short voice responses — 1-3 sentences
        metadataSendMode: "off" as const,
      },
      voice: {
        ...voice,
        // Progressive TTS chunking for faster first-byte
        chunkPlan: {
          enabled: true,
          minCharacters: 30,
          punctuationBoundaries: [
            ".",
            "!",
            "?",
            ",",
            ";",
          ],
          formatPlan: {
            enabled: true,
            numberToDigitsCutoff: 2025,
          },
        },
        // Filler words during tool calls / thinking
        fillerInjectionEnabled: true,
      },
      transcriber: {
        ...transcriber,
        // Endpointing: wait 350ms after silence before processing
        // Balances responsiveness vs accidental cutoff
        endpointing: 350,
      },
      firstMessage: config.firstMessage,
      silenceTimeoutSeconds: 20, // Shorter — 20s feels more natural
      maxDurationSeconds: 600, // 10 min max call
      backgroundSound: "office", // Subtle ambient noise reduces awkward silence
      backchannelingEnabled: true,
      // Responsiveness: 0-1 scale, higher = faster but might cut off user
      responsiveness: 0.55,
      endCallMessage: "Great talking to you! Call back anytime.",
      endCallPhrases: ["goodbye", "bye", "end call", "that's all", "alvida", "bye bye", "band karo"],
      // Barge-in / interruption handling
      clientMessages: [
        "transcript",
        "hang",
        "function-call",
        "speech-update",
        "status-update",
        "end-of-call-report",
      ],
      serverMessages: [
        "end-of-call-report",
        "status-update",
        "function-call",
        "tool-calls",
      ],
    };

    // Update existing assistant or create new one
    if (env.VAPI_ASSISTANT_ID) {
      await this.request(`/assistant/${env.VAPI_ASSISTANT_ID}`, {
        method: "PATCH",
        body: JSON.stringify(assistantPayload),
      });
      return { assistantId: env.VAPI_ASSISTANT_ID };
    }

    const result = await this.request<VapiAssistant>("/assistant", {
      method: "POST",
      body: JSON.stringify(assistantPayload),
    });

    return { assistantId: result.id };
  }

  async getWebToken(): Promise<string> {
    // Vapi Web SDK uses the public key directly, no token exchange needed
    if (!env.NEXT_PUBLIC_VAPI_PUBLIC_KEY) {
      throw new Error("NEXT_PUBLIC_VAPI_PUBLIC_KEY is required for web calling");
    }
    return env.NEXT_PUBLIC_VAPI_PUBLIC_KEY;
  }

  async getPhoneNumber(): Promise<string | null> {
    if (!env.VAPI_PHONE_NUMBER_ID) return null;

    const result = await this.request<{ number: string }>(
      `/phone-number/${env.VAPI_PHONE_NUMBER_ID}`
    );
    return result.number;
  }

  async handleWebhook(payload: unknown): Promise<WebhookResponse> {
    const data = payload as VapiWebhookPayload;
    const message = data?.message ?? ({} as VapiWebhookMessage);
    const messageType = message?.type || data?.type;

    switch (messageType) {
      case "function-call":
      case "tool-calls":
        return {
          type: "tool_call",
          data: {
            toolCalls: message?.toolCalls || (message?.functionCall
              ? [message.functionCall]
              : []),
            call: message?.call,
          },
        };

      case "end-of-call-report":
        return {
          type: "end_of_call",
          data: {
            summary: message?.summary,
            duration: message?.endedReason,
            transcript: message?.transcript,
            recordingUrl: message?.recordingUrl,
          },
        };

      case "status-update":
        return {
          type: "status_update",
          data: {
            status: message?.status,
          },
        };

      default:
        return { type: "unknown", data: data as Record<string, unknown> };
    }
  }

  // --- Private helpers ---

  private getTranscriberConfig(language: string) {
    // Deepgram Nova-3 with keyword boosting for persona-specific terms
    const personaKeywords = [
      // Name recognition — high boost
      `${env.PERSONA_NAME}:3`,
      // Split name parts for better partial recognition
      ...env.PERSONA_NAME.split(" ").map((part) => `${part}:3`),
      // Technical terms that STT often misrecognizes
      "RAG:2", "LLM:2", "pgvector:2", "Supabase:2", "Docker:2",
      "Kubernetes:2", "TypeScript:2", "Next.js:2", "Vercel:2",
      "gRPC:2", "WebSocket:2", "Redis:2", "PostgreSQL:2",
    ];

    if (language === "multilingual" || language === "hi") {
      return {
        provider: "deepgram" as const,
        model: "nova-3",
        language: "multi", // Deepgram auto-detects Hindi/English
        smartFormat: true,
        keywords: personaKeywords,
      };
    }

    return {
      provider: "deepgram" as const,
      model: "nova-3",
      language: "en",
      smartFormat: true,
      keywords: personaKeywords,
    };
  }

  private getVoiceConfig(config: VoiceAssistantConfig) {
    // ElevenLabs for best quality Indian English voice
    if (config.voiceId) {
      return {
        provider: "11labs" as const,
        voiceId: config.voiceId,
        stability: 0.5,
        similarityBoost: 0.75,
        speed: 1.0,
      };
    }

    // Default: ElevenLabs with a professional male Indian voice
    // You can change this to any ElevenLabs voice ID
    return {
      provider: "11labs" as const,
      voiceId: env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB", // Adam - neutral professional
      stability: 0.5,
      similarityBoost: 0.75,
      speed: 1.0,
      model: "eleven_turbo_v2_5", // Lowest latency model
    };
  }
}
