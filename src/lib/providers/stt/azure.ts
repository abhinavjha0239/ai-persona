import type { STTProvider, STTOptions, TranscriptionResult } from "../types";
export class AzureSTTProvider implements STTProvider {
  readonly id = "azure";
  async transcribe(_audio: Buffer, _options?: STTOptions): Promise<TranscriptionResult> { throw new Error("STT is handled by the voice platform"); }
}
