import type { VoiceEvent } from "./core/types.js";

export type TranscriptSpeaker = "YOU" | "Gemini" | "PROMPT";

export interface TranscriptTurn {
  speaker: TranscriptSpeaker;
  text: string;
  at: string;
}

export interface VoiceStatus {
  desiredListening: boolean;
  activeClients: number;
  providerConnected: boolean;
  latestSession?: string;
  lastEventAt?: string;
  lastError?: string;
  videoFrames: number;
  lastVideoAt?: string;
}

export interface VoiceTranscriptSnapshot {
  turns: TranscriptTurn[];
  prompt: string;
}

export class VoiceSessionState {
  private desiredListening = false;
  private providerConnected = false;
  private latestSession?: string;
  private lastEventAt?: string;
  private lastError?: string;
  private videoFrames = 0;
  private lastVideoAt?: string;
  private turns: TranscriptTurn[] = [];

  requestStart(): void {
    this.desiredListening = true;
  }

  requestStop(): void {
    this.desiredListening = false;
    this.providerConnected = false;
  }

  noteVideoFrame(): void {
    this.videoFrames += 1;
    this.lastVideoAt = new Date().toISOString();
    this.lastEventAt = this.lastVideoAt;
  }

  setSession(session: string): void {
    this.latestSession = session;
    this.lastEventAt = new Date().toISOString();
  }

  handleEvent(event: VoiceEvent): void {
    this.lastEventAt = new Date().toISOString();

    if (event.type === "connected") {
      this.providerConnected = true;
      this.lastError = undefined;
      return;
    }

    if (event.type === "closed") {
      this.providerConnected = false;
      return;
    }

    if (event.type === "error") {
      this.lastError = event.error.message;
      return;
    }

    if (event.type === "input_transcript") {
      this.appendTurn("YOU", event.text);
      return;
    }

    if (event.type === "input_prompt") {
      this.appendTurn("PROMPT", event.text);
      return;
    }

    if (event.type === "output_transcript") {
      this.appendTurn("Gemini", event.text);
    }
  }

  clearTranscript(): void {
    this.turns = [];
  }

  getStatus(activeClients: number): VoiceStatus {
    return {
      desiredListening: this.desiredListening,
      activeClients,
      providerConnected: this.providerConnected,
      latestSession: this.latestSession,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      videoFrames: this.videoFrames,
      lastVideoAt: this.lastVideoAt,
    };
  }

  getTranscript(): VoiceTranscriptSnapshot {
    return {
      turns: this.turns.map((turn) => ({ ...turn })),
      prompt: this.formatCursorPrompt(),
    };
  }

  formatCursorPrompt(): string {
    const spokenText = this.turns
      .filter((turn) => turn.speaker === "YOU")
      .map((turn) => turn.text.trim())
      .filter(Boolean)
      .join("\n\n");

    if (!spokenText) return "";

    return [
      "Voice request for Cursor:",
      "",
      spokenText,
      "",
      "Treat this as a spoken request. Resolve obvious transcription errors from context, ask before destructive changes, and keep changes scoped.",
    ].join("\n");
  }

  private appendTurn(speaker: TranscriptSpeaker, text: string): void {
    const latest = this.turns.at(-1);
    if (latest?.speaker === speaker) {
      latest.text += text;
      return;
    }

    this.turns.push({
      speaker,
      text,
      at: new Date().toISOString(),
    });
  }
}
