import type { STTProvider, STTOptions, TranscriptionResult } from "../types";
export class DeepgramSTTProvider implements STTProvider {
  readonly id = "deepgram";
  async transcribe(_audio: Buffer, _options?: STTOptions): Promise<TranscriptionResult> { throw new Error("STT is handled by the voice platform"); }
}
