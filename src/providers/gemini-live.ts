import { GoogleGenAI, Modality, type Session } from "@google/genai";
import { buildLiveSystemInstruction, defaultLiveVoice, type LiveMode } from "../core/live.js";
import { defaultVideoPack, type VideoPack } from "../core/screen-pack.js";
import type { VoiceEventHandler, VoiceProvider } from "../core/types.js";
import { trace, errText } from "../trace.js";

export interface GeminiLiveOptions {
  apiKey: string;
  model: string;
  language: string;
  mode?: LiveMode;
  style?: string;
  voice?: string;
  videoPack?: VideoPack;
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
    const mode = this.options.mode ?? "conversation";
    const started = Date.now();
    trace.debug(
      "gemini.live",
      "connect.begin",
      `model=${this.options.model} mode=${mode} voice=${this.options.voice ?? defaultLiveVoice}`,
    );
    try {
      this.session = await ai.live.connect({
      model: this.options.model,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.options.voice ?? defaultLiveVoice,
            },
          },
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            silenceDurationMs: 1400,
          },
        },
        systemInstruction: {
          parts: [
            {
              text: buildLiveSystemInstruction({
                language: this.options.language,
                mode,
                style: this.options.style,
                videoPack: this.options.videoPack ?? defaultVideoPack,
              }),
            },
          ],
        },
      },
      callbacks: {
        onopen: () => {
          trace.info("gemini.live", "sock.open", `ms=${Date.now() - started}`);
          onEvent({ type: "connected", provider: this.name });
        },
        onmessage: (message) => {
          const content = message.serverContent;
          const input = content?.inputTranscription?.text;
          if (input) onEvent({ type: "input_transcript", text: input });

          const output = content?.outputTranscription?.text;
          if (output) onEvent({ type: "output_transcript", text: output });

          let audioParts = 0;
          for (const part of content?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) {
              audioParts += 1;
              onEvent({
                type: "output_audio",
                data: Buffer.from(part.inlineData.data, "base64"),
                sampleRate: 24000,
              });
            }
          }

          if (content?.interrupted) onEvent({ type: "interrupted" });
          if (content?.turnComplete) onEvent({ type: "turn_complete" });
          if (input || output || audioParts || content?.interrupted || content?.turnComplete) {
            trace.trace(
              "gemini.live",
              "msg",
              `in=${input?.length ?? 0} out=${output?.length ?? 0} audio=${audioParts}${content?.interrupted ? " interrupt" : ""}${content?.turnComplete ? " turn_done" : ""}`,
            );
          }
        },
        onerror: (event) => {
          trace.error("gemini.live", "sock.err", event.message || "Gemini Live connection failed");
          onEvent({
            type: "error",
            error: new Error(event.message || "Gemini Live connection failed"),
          });
        },
        onclose: (event) => {
          trace.warn("gemini.live", "sock.close", event.reason || "no-reason");
          onEvent({ type: "closed", reason: event.reason });
        },
      },
    });
    } catch (error) {
      trace.error("gemini.live", "connect.fail", errText(error));
      throw error;
    }
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

  sendText(text: string): void {
    if (!this.session) throw new Error("Gemini session is not connected");
    this.onEvent?.({ type: "input_prompt", text });
    this.session.sendRealtimeInput({ text });
  }

  async close(): Promise<void> {
    trace.debug("gemini.live", "close");
    this.session?.close();
    this.session = undefined;
    this.onEvent = undefined;
  }
}
