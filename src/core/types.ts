export type VoiceEvent =
  | { type: "connected"; provider: string }
  | { type: "input_transcript"; text: string }
  | { type: "output_transcript"; text: string }
  | { type: "output_audio"; data: Buffer; sampleRate: 24000 }
  | { type: "turn_complete" }
  | { type: "interrupted" }
  | { type: "error"; error: Error }
  | { type: "closed"; reason?: string };

export type VoiceEventHandler = (event: VoiceEvent) => void;

export interface VoiceProvider {
  readonly name: string;
  connect(onEvent: VoiceEventHandler): Promise<void>;
  sendAudio(chunk: Buffer): void;
  close(): Promise<void>;
}

export interface AudioSource {
  start(onAudio: (chunk: Buffer) => void): Promise<void>;
  stop(): Promise<void>;
}
