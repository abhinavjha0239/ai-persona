import type { TTSProvider, TTSOptions, VoiceInfo } from "../types";
export class DeepgramTTSProvider implements TTSProvider {
  readonly id = "deepgram";
  async synthesize(_text: string, _options: TTSOptions): Promise<Buffer> { throw new Error("TTS is handled by the voice platform"); }
  async listVoices(_language?: string): Promise<VoiceInfo[]> { return []; }
}
