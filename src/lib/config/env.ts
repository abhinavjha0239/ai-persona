import { z } from "zod";

// ============================================================
// Environment validation with Zod
// Fail fast at startup if config is missing
// ============================================================

const providerEnum = {
  voice: z.enum(["vapi", "retell", "bolna"]).default("vapi"),
  llm: z.enum(["openai", "anthropic", "groq", "google", "azure-openai", "bedrock"]).default("azure-openai"),
  calendar: z.enum(["calcom", "calendly", "google"]).default("calcom"),
  tts: z.enum(["elevenlabs", "azure", "deepgram", "playht"]).default("elevenlabs"),
  stt: z.enum(["deepgram", "azure", "assemblyai"]).default("deepgram"),
  embedding: z.enum(["openai", "google", "cohere", "voyage", "azure-openai"]).default("azure-openai"),
  vectorStore: z.enum(["azure-pg", "supabase", "pinecone", "qdrant", "chroma"]).default("azure-pg"),
} as const;

const envSchema = z.object({
  // Provider selection
  VOICE_PROVIDER: providerEnum.voice,
  LLM_PROVIDER: providerEnum.llm,
  CALENDAR_PROVIDER: providerEnum.calendar,
  TTS_PROVIDER: providerEnum.tts,
  STT_PROVIDER: providerEnum.stt,
  EMBEDDING_PROVIDER: providerEnum.embedding,
  VECTOR_STORE_PROVIDER: providerEnum.vectorStore,

  // Voice
  VAPI_API_KEY: z.string().optional(),
  VAPI_ASSISTANT_ID: z.string().optional(),
  VAPI_PHONE_NUMBER_ID: z.string().optional(),
  VAPI_WEBHOOK_SECRET: z.string().optional(),
  NEXT_PUBLIC_VAPI_PUBLIC_KEY: z.string().optional(),
  RETELL_API_KEY: z.string().optional(),
  BOLNA_API_KEY: z.string().optional(),
  BOLNA_AGENT_ID: z.string().optional(),

  // LLM
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),

  // AWS Bedrock
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default("ap-south-1"),
  BEDROCK_MODEL_ID: z.string().default("anthropic.claude-haiku-4-5-20251001-v1:0"),

  // Azure OpenAI
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_RESOURCE_NAME: z.string().optional(),
  AZURE_OPENAI_CHAT_DEPLOYMENT: z.string().default("gpt-5-4-mini"),
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: z.string().default("text-embedding-3-small"),

  // TTS
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  AZURE_SPEECH_KEY: z.string().optional(),
  AZURE_SPEECH_REGION: z.string().default("centralindia"),

  // STT
  DEEPGRAM_API_KEY: z.string().optional(),

  // Calendar
  CALCOM_API_KEY: z.string().optional(),
  CALCOM_EVENT_TYPE_ID: z.string().optional(),
  CALCOM_BASE_URL: z.string().default("https://api.cal.com/v2"),
  CALENDLY_API_KEY: z.string().optional(),
  CALENDLY_EVENT_URI: z.string().optional(),

  // Vector store — Azure PostgreSQL (default)
  AZURE_PG_CONNECTION_STRING: z.string().optional(),

  // Vector store — Supabase (alternative)
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  PINECONE_API_KEY: z.string().optional(),
  PINECONE_INDEX: z.string().optional(),

  // Persona
  PERSONA_NAME: z.string().default("Abhinav Jha"),
  PERSONA_ROLE: z.string().default("AI/ML Engineer"),
  PERSONA_LANGUAGE: z.enum(["en", "hi", "multilingual"]).default("multilingual"),

  // App
  NEXT_PUBLIC_APP_URL: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration. Check .env.local");
  }
  return parsed.data;
}

export const env = loadEnv();
