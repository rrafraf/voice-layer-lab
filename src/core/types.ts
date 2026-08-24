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
  sendVideo(chunk: Buffer, mimeType?: string): void;
  close(): Promise<void>;
}

export interface AudioSource {
  start(onAudio: (chunk: Buffer) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface TtsRequest {
  text: string;
  model: string;
  voice: string;
  language?: string;
  style?: string;
  exact?: boolean;
}

export interface TtsSynthesis {
  pcm: Buffer;
  sampleRate: 24000;
  model: string;
  voice: string;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(request: TtsRequest): Promise<TtsSynthesis>;
}
