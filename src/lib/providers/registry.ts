import { env } from "@/lib/config/env";
import type {
  ProviderType,
  ProviderMap,
  VoiceProvider,
  LLMProvider,
  CalendarProvider,
  TTSProvider,
  STTProvider,
  EmbeddingProvider,
  VectorStoreProvider,
} from "./types";

// ============================================================
// Provider Registry — The Service Locator
// ============================================================
// Resolves the correct provider implementation based on env
// config. Caches instances (singleton per provider type).
//
// Usage:
//   const voice = await getProvider("voice");
//   const calendar = await getProvider("calendar");
//
// Switch providers by changing .env.local:
//   VOICE_PROVIDER=vapi  →  VOICE_PROVIDER=retell
//   That's it. Zero code changes.
// ============================================================

type ProviderFactory<T> = () => Promise<T>;

const factories: Record<ProviderType, Record<string, ProviderFactory<unknown>>> = {
  voice: {
    vapi: () => import("./voice/vapi").then((m) => new m.VapiVoiceProvider()),
    retell: () => import("./voice/retell").then((m) => new m.RetellVoiceProvider()),
    bolna: () => import("./voice/bolna").then((m) => new m.BolnaVoiceProvider()),
  },
  llm: {
    openai: () => import("./llm/openai").then((m) => new m.OpenAILLMProvider()),
    anthropic: () => import("./llm/anthropic").then((m) => new m.AnthropicLLMProvider()),
    groq: () => import("./llm/groq").then((m) => new m.GroqLLMProvider()),
    google: () => import("./llm/google").then((m) => new m.GoogleLLMProvider()),
    "azure-openai": () => import("./llm/azure-openai").then((m) => new m.AzureOpenAILLMProvider()),
  },
  calendar: {
    calcom: () => import("./calendar/calcom").then((m) => new m.CalComProvider()),
    calendly: () => import("./calendar/calendly").then((m) => new m.CalendlyProvider()),
    google: () => import("./calendar/google-cal").then((m) => new m.GoogleCalendarProvider()),
  },
  tts: {
    elevenlabs: () => import("./tts/elevenlabs").then((m) => new m.ElevenLabsTTSProvider()),
    azure: () => import("./tts/azure").then((m) => new m.AzureTTSProvider()),
    deepgram: () => import("./tts/deepgram").then((m) => new m.DeepgramTTSProvider()),
    playht: () => import("./tts/playht").then((m) => new m.PlayHTTTSProvider()),
  },
  stt: {
    deepgram: () => import("./stt/deepgram").then((m) => new m.DeepgramSTTProvider()),
    azure: () => import("./stt/azure").then((m) => new m.AzureSTTProvider()),
    assemblyai: () => import("./stt/assemblyai").then((m) => new m.AssemblyAISTTProvider()),
  },
  embedding: {
    openai: () => import("./embedding/openai").then((m) => new m.OpenAIEmbeddingProvider()),
    google: () => import("./embedding/google").then((m) => new m.GoogleEmbeddingProvider()),
    cohere: () => import("./embedding/cohere").then((m) => new m.CohereEmbeddingProvider()),
    voyage: () => import("./embedding/voyage").then((m) => new m.VoyageEmbeddingProvider()),
    "azure-openai": () => import("./embedding/azure-openai").then((m) => new m.AzureOpenAIEmbeddingProvider()),
  },
  vectorStore: {
    "azure-pg": () => import("./vector-store/azure-pg").then((m) => new m.AzurePgVectorStore()),
    supabase: () => import("./vector-store/supabase").then((m) => new m.SupabaseVectorStore()),
    pinecone: () => import("./vector-store/pinecone").then((m) => new m.PineconeVectorStore()),
    qdrant: () => import("./vector-store/qdrant").then((m) => new m.QdrantVectorStore()),
    chroma: () => import("./vector-store/chroma").then((m) => new m.ChromaVectorStore()),
  },
};

// Maps env variable names to provider type keys
const providerEnvMap: Record<ProviderType, string> = {
  voice: "VOICE_PROVIDER",
  llm: "LLM_PROVIDER",
  calendar: "CALENDAR_PROVIDER",
  tts: "TTS_PROVIDER",
  stt: "STT_PROVIDER",
  embedding: "EMBEDDING_PROVIDER",
  vectorStore: "VECTOR_STORE_PROVIDER",
};

// Singleton cache
const instances = new Map<ProviderType, unknown>();

/**
 * Get the configured provider instance for a given type.
 * Cached after first resolution (singleton per type).
 *
 * @example
 *   const voice = await getProvider("voice");
 *   const calendar = await getProvider("calendar");
 */
export async function getProvider<T extends ProviderType>(
  type: T
): Promise<ProviderMap[T]> {
  // Return cached instance
  if (instances.has(type)) {
    return instances.get(type) as ProviderMap[T];
  }

  const providerName = env[providerEnvMap[type] as keyof typeof env] as string;
  const typeFactories = factories[type];

  if (!typeFactories[providerName]) {
    const available = Object.keys(typeFactories).join(", ");
    throw new Error(
      `Unknown ${type} provider: "${providerName}". Available: ${available}. ` +
      `Set ${providerEnvMap[type]} in .env.local`
    );
  }

  const instance = await typeFactories[providerName]();
  instances.set(type, instance);

  return instance as ProviderMap[T];
}

/** Clear the provider cache (useful for testing) */
export function clearProviderCache(): void {
  instances.clear();
}

// Convenience typed getters
export const getVoiceProvider = () => getProvider("voice") as Promise<VoiceProvider>;
export const getLLMProvider = () => getProvider("llm") as Promise<LLMProvider>;
export const getCalendarProvider = () => getProvider("calendar") as Promise<CalendarProvider>;
export const getTTSProvider = () => getProvider("tts") as Promise<TTSProvider>;
export const getSTTProvider = () => getProvider("stt") as Promise<STTProvider>;
export const getEmbeddingProvider = () => getProvider("embedding") as Promise<EmbeddingProvider>;
export const getVectorStoreProvider = () => getProvider("vectorStore") as Promise<VectorStoreProvider>;
