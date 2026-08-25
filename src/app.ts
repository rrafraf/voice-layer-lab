import type {
  AudioSource,
  VoiceEvent,
  VoiceEventHandler,
  VoiceProvider,
} from "./core/types.js";

export class VoiceLab {
  private started = false;

  constructor(
    private readonly audio: AudioSource,
    private readonly provider: VoiceProvider,
    private readonly onEvent: VoiceEventHandler,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("Voice lab is already running");
    await this.provider.connect(this.onEvent);
    try {
      await this.audio.start((chunk) => this.provider.sendAudio(chunk));
      this.started = true;
    } catch (error) {
      await this.provider.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.audio.stop();
    await this.provider.close();
  }
}

export function formatEvent(event: VoiceEvent): string | undefined {
  switch (event.type) {
    case "connected":
      return `Connected to ${event.provider}. Speak now; press Ctrl+C to stop.`;
    case "input_transcript":
      return `You: ${event.text}`;
    case "input_prompt":
      return `Prompt: ${event.text}`;
    case "output_transcript":
      return `Model: ${event.text}`;
    case "output_audio":
      return undefined;
    case "turn_complete":
      return undefined;
    case "interrupted":
      return "[interrupted]";
    case "error":
      return `Error: ${event.error.message}`;
    case "closed":
      return event.reason ? `Closed: ${event.reason}` : "Closed";
  }
}
