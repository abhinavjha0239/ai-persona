// ============================================================
// Provider Interfaces — The Contracts
// ============================================================
// Every provider implements an interface. Swap implementations
// by changing one env var. Zero code changes needed.
// ============================================================

// --- Voice Provider -----------------------------------------

export interface VoiceAssistantConfig {
  name: string;
  systemPrompt: string;
  firstMessage: string;
  language: "en" | "hi" | "multilingual";
  tools: ToolDefinition[];
  voiceId?: string;
  model?: string;
}

export interface VoiceProvider {
  readonly id: string;

  /** Create or update the voice assistant */
  createAssistant(config: VoiceAssistantConfig): Promise<{ assistantId: string }>;

  /** Get a web token for client-side SDK */
  getWebToken(): Promise<string>;

  /** Get the phone number associated with the assistant */
  getPhoneNumber(): Promise<string | null>;

  /** Handle incoming webhook from voice platform */
  handleWebhook(payload: unknown): Promise<WebhookResponse>;
}

export interface WebhookResponse {
  type: "tool_call" | "end_of_call" | "status_update" | "unknown";
  data: Record<string, unknown>;
}

// --- LLM Provider -------------------------------------------

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface LLMStreamOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
}

export interface LLMProvider {
  readonly id: string;

  /** Stream a chat completion */
  streamChat(messages: LLMMessage[], options?: LLMStreamOptions): Promise<ReadableStream>;

  /** Non-streaming completion (for tools, evals) */
  complete(messages: LLMMessage[], options?: LLMStreamOptions): Promise<string>;

  /** Generate embeddings */
  embed?(text: string | string[]): Promise<number[][]>;
}

// --- Calendar Provider --------------------------------------

export interface TimeSlot {
  start: string;  // ISO 8601
  end: string;    // ISO 8601
}

export interface BookingRequest {
  startTime: string;     // ISO 8601
  attendeeName: string;
  attendeeEmail: string;
  attendeeTimezone?: string;
  notes?: string;
}

export interface BookingConfirmation {
  id: string;
  status: "confirmed" | "pending";
  startTime: string;
  endTime: string;
  meetingUrl?: string;
  attendeeName: string;
  attendeeEmail: string;
}

export interface CalendarProvider {
  readonly id: string;

  /** Get available time slots for a date range */
  getAvailableSlots(startDate: string, endDate: string): Promise<TimeSlot[]>;

  /** Create a booking */
  createBooking(request: BookingRequest): Promise<BookingConfirmation>;

  /** Cancel a booking */
  cancelBooking(bookingId: string): Promise<{ success: boolean }>;

  /** Get booking details */
  getBooking(bookingId: string): Promise<BookingConfirmation | null>;
}

// --- TTS Provider -------------------------------------------

export interface TTSOptions {
  voiceId: string;
  language?: string;
  speed?: number;
  emotion?: string;
}

export interface TTSProvider {
  readonly id: string;

  /** Convert text to speech audio buffer */
  synthesize(text: string, options: TTSOptions): Promise<Buffer>;

  /** List available voices */
  listVoices(language?: string): Promise<VoiceInfo[]>;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  gender: "male" | "female" | "neutral";
  preview_url?: string;
}

// --- STT Provider -------------------------------------------

export interface STTOptions {
  language?: string;
  model?: string;
  enablePunctuation?: boolean;
  enableWordTimestamps?: boolean;
}

export interface STTProvider {
  readonly id: string;

  /** Transcribe audio buffer */
  transcribe(audio: Buffer, options?: STTOptions): Promise<TranscriptionResult>;
}

export interface TranscriptionResult {
  text: string;
  confidence: number;
  language?: string;
  words?: { word: string; start: number; end: number; confidence: number }[];
}

// --- Embedding Provider -------------------------------------

export interface EmbeddingProvider {
  readonly id: string;

  /** Generate embeddings for text(s) */
  embed(input: string | string[]): Promise<number[][]>;

  /** Dimensions of the embedding vector */
  readonly dimensions: number;

  /** Model name for reference */
  readonly model: string;
}

// --- Vector Store Provider ----------------------------------

export interface VectorDocument {
  id: string;
  content: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
}

export interface VectorSearchResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface VectorStoreProvider {
  readonly id: string;

  /** Upsert documents into the vector store */
  upsert(documents: VectorDocument[]): Promise<void>;

  /** Search by similarity */
  search(query: number[], topK?: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]>;

  /** Delete documents by IDs */
  delete(ids: string[]): Promise<void>;
}

// --- Tool Definition (shared across voice + chat) -----------

export interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  enum?: string[];
  required?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  required?: string[];
}

// --- Provider Registry Types --------------------------------

export type ProviderType =
  | "voice"
  | "llm"
  | "calendar"
  | "tts"
  | "stt"
  | "embedding"
  | "vectorStore";

export type ProviderMap = {
  voice: VoiceProvider;
  llm: LLMProvider;
  calendar: CalendarProvider;
  tts: TTSProvider;
  stt: STTProvider;
  embedding: EmbeddingProvider;
  vectorStore: VectorStoreProvider;
};
