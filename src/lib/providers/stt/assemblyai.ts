import type { STTProvider, STTOptions, TranscriptionResult } from "../types";
export class AssemblyAISTTProvider implements STTProvider {
  readonly id = "assemblyai";
  async transcribe(_audio: Buffer, _options?: STTOptions): Promise<TranscriptionResult> { throw new Error("STT is handled by the voice platform"); }
}
