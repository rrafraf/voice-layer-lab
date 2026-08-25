import {
  buildVisionPackInstruction,
  defaultVideoPack,
  parseVideoPack,
  videoPacks,
  type VideoPack,
} from "./screen-pack.js";
import { ttsVoices } from "./tts.js";
import { parseRealtimeVideoMessage, type VideoFrame } from "./video.js";

export const liveModes = ["conversation", "narration", "transcribe"] as const;
export type LiveMode = (typeof liveModes)[number];
export const maxLivePromptChars = 2000;
export const defaultLiveVoice = "Kore";

export interface LiveSessionConfig {
  mode: LiveMode;
  style?: string;
  voice: string;
  videoPack: VideoPack;
}

export type LiveClientMessage =
  | ({ type: "session" } & LiveSessionConfig)
  | { type: "text"; text: string }
  | ({ type: "video" } & VideoFrame);

export function isLiveMode(value: unknown): value is LiveMode {
  return typeof value === "string" && (liveModes as readonly string[]).includes(value);
}

export function buildLiveSystemInstruction(options: {
  language: string;
  mode: LiveMode;
  style?: string;
  videoPack?: VideoPack;
}): string {
  const style = options.style?.trim();
  const styleLine = style ? ` Voice and delivery style: ${style}.` : "";
  const vision = buildVisionPackInstruction(options.videoPack ?? defaultVideoPack);

  if (options.mode === "transcribe") {
    return `Act only as a silent realtime transcription session. Listen in ${options.language}. Do not speak or answer the user.`;
  }

  if (options.mode === "narration") {
    return [
      `You are a calm realtime narrator in ${options.language}.`,
      "Watch JPEG frames and listen. Speak only when something readable actually changed.",
      "If you are not sure, say you cannot read it. Do not guess. Do not interview the user.",
      "One or two short present-tense sentences, then wait.",
      "Let the user interrupt. After you speak, stay quiet until they talk or a clear on-screen error appears.",
      vision,
      "Text prompts from the user steer what to attend to; follow them.",
      styleLine.trim(),
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    `You are a calm realtime voice assistant in ${options.language}. The user is in control.`,
    "Wait them out. Do not fill silence. Do not rapid-fire questions. Do not be pushy.",
    "Reply only when they asked something, or when a readable on-screen error or dialog clearly needs one short note.",
    "One short answer, then stop and listen. Leave a pause. Let them interrupt.",
    "JPEG frames may arrive from camera or screen at about 1 FPS.",
    vision,
    "Text prompts are steering instructions. Follow them without adding extra interrogation.",
    styleLine.trim(),
  ]
    .filter(Boolean)
    .join(" ");
}

export function describeLiveApi() {
  return {
    kind: "live" as const,
    transport: "bidirectional-native-audio" as const,
    inputs: ["audio", "video", "text"] as const,
    outputs: {
      audio: true,
      text: "output audio transcription",
      note: "Native Live models accept only one response modality per session. AUDIO is required; text arrives as a transcript of the spoken response, not a second TEXT modality.",
    },
    modes: [...liveModes],
    videoPacks: [...videoPacks],
    voices: ttsVoices.map((voice) => ({ ...voice })),
    defaultMode: "conversation" as const,
    defaultVoice: defaultLiveVoice,
    defaultVideoPack,
    maxPromptChars: maxLivePromptChars,
  };
}

export function parseLiveClientMessage(raw: string): LiveClientMessage {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("Live client message must be JSON.");
  }

  if (!isRecord(payload) || typeof payload.type !== "string") {
    throw new Error("Not a live client message");
  }

  if (payload.type === "video") {
    const frame = parseRealtimeVideoMessage(raw);
    return { type: "video", ...frame };
  }

  if (payload.type === "text") {
    if (typeof payload.text !== "string") throw new Error("Live text prompt is missing.");
    const text = payload.text.trim();
    if (!text) throw new Error("Live text prompt is empty.");
    if (text.length > maxLivePromptChars) {
      throw new Error(`Live text prompt is ${text.length} characters; max is ${maxLivePromptChars}.`);
    }
    return { type: "text", text };
  }

  if (payload.type === "session") {
    const mode = isLiveMode(payload.mode) ? payload.mode : "conversation";
    const style = typeof payload.style === "string" ? payload.style.trim() : undefined;
    const voice =
      typeof payload.voice === "string" && payload.voice.trim()
        ? payload.voice.trim()
        : defaultLiveVoice;
    return {
      type: "session",
      mode,
      style: style || undefined,
      voice,
      videoPack: parseVideoPack(payload.videoPack),
    };
  }

  throw new Error("Not a live client message");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
