import { GoogleGenAI, Modality, type Session } from "@google/genai";
import type { VoiceEventHandler, VoiceProvider } from "../core/types.js";

export interface GeminiLiveOptions {
  apiKey: string;
  model: string;
  language: string;
  behavior?: "transcribe" | "conversation";
}

export class GeminiLiveProvider implements VoiceProvider {
  readonly name = "gemini";
  private session?: Session;
  private onEvent?: VoiceEventHandler;

  constructor(private readonly options: GeminiLiveOptions) {}

  async connect(onEvent: VoiceEventHandler): Promise<void> {
    if (this.session) throw new Error("Gemini session is already connected");
    this.onEvent = onEvent;

    const ai = new GoogleGenAI({ apiKey: this.options.apiKey });
    const behavior = this.options.behavior ?? "transcribe";
    this.session = await ai.live.connect({
      model: this.options.model,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            silenceDurationMs: 650,
          },
        },
        systemInstruction: {
          parts: [
            {
              text:
                behavior === "transcribe"
                  ? `Act only as a silent realtime transcription session. Listen in ${this.options.language}. Do not speak or answer the user.`
                  : `You are a concise realtime voice assistant. Listen and respond naturally in ${this.options.language}. JPEG frames may arrive from the user's camera or screen at about 1 FPS. Use them when the user refers to what is visible. Do not invent UI or code that is not in the frames. Let the user interrupt you.`,
            },
          ],
        },
      },
      callbacks: {
        onopen: () => onEvent({ type: "connected", provider: this.name }),
        onmessage: (message) => {
          const content = message.serverContent;
          const input = content?.inputTranscription?.text;
          if (input) onEvent({ type: "input_transcript", text: input });

          const output = content?.outputTranscription?.text;
          if (output) onEvent({ type: "output_transcript", text: output });

          for (const part of content?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) {
              onEvent({
                type: "output_audio",
                data: Buffer.from(part.inlineData.data, "base64"),
                sampleRate: 24000,
              });
            }
          }

          if (content?.interrupted) onEvent({ type: "interrupted" });
          if (content?.turnComplete) onEvent({ type: "turn_complete" });
        },
        onerror: (event) => {
          onEvent({
            type: "error",
            error: new Error(event.message || "Gemini Live connection failed"),
          });
        },
        onclose: (event) => onEvent({ type: "closed", reason: event.reason }),
      },
    });
  }

  sendAudio(chunk: Buffer): void {
    if (!this.session) throw new Error("Gemini session is not connected");
    this.session.sendRealtimeInput({
      audio: {
        data: chunk.toString("base64"),
        mimeType: "audio/pcm;rate=16000",
      },
    });
  }

  sendVideo(chunk: Buffer, mimeType = "image/jpeg"): void {
    if (!this.session) throw new Error("Gemini session is not connected");
    this.session.sendRealtimeInput({
      video: {
        data: chunk.toString("base64"),
        mimeType,
      },
    });
  }

  async close(): Promise<void> {
    this.session?.close();
    this.session = undefined;
    this.onEvent = undefined;
  }
}
