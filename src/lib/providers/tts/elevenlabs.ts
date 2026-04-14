import type { TTSProvider, TTSOptions, VoiceInfo } from "../types";
export class ElevenLabsTTSProvider implements TTSProvider {
  readonly id = "elevenlabs";
  async synthesize(_text: string, _options: TTSOptions): Promise<Buffer> { throw new Error("TTS is handled by the voice platform (Vapi/Retell)"); }
  async listVoices(_language?: string): Promise<VoiceInfo[]> { return []; }
}
