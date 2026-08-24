import { config as loadEnvFile } from "dotenv";
import { defaultTtsModel, defaultTtsVoice } from "./core/tts.js";

loadEnvFile({ path: [".env.local", ".env"], quiet: true });

export interface AppConfig {
  apiKey: string;
  provider: "gemini";
  mode: "transcribe" | "conversation";
  language: string;
  inputDevice: string;
  model: string;
  ttsModel: string;
  ttsVoice: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is missing. Add it to .env.local or the process environment.",
    );
  }

  const provider = env.VOICE_PROVIDER ?? "gemini";
  if (provider !== "gemini") {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const mode = env.VOICE_MODE ?? "transcribe";
  if (mode !== "transcribe" && mode !== "conversation") {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  return {
    apiKey,
    provider,
    mode,
    language: env.VOICE_LANGUAGE ?? "en-US",
    inputDevice:
      env.VOICE_INPUT_DEVICE ??
      "Microphone (2- Realtek High Definition Audio)",
    model: env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview",
    ttsModel: env.GEMINI_TTS_MODEL?.trim() || defaultTtsModel,
    ttsVoice: env.GEMINI_TTS_VOICE?.trim() || defaultTtsVoice,
  };
}
