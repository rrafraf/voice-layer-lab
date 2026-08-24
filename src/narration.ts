import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  defaultNarrationOutput,
  defaultTtsModel,
  defaultTtsVoice,
  estimateTokens,
  guardNarrationText,
  normalizeNarrationText,
  pcmToWav,
} from "./core/tts.js";
import type { TtsProvider } from "./core/types.js";
import { GeminiTtsProvider } from "./providers/gemini-tts.js";

export {
  defaultNarrationOutput,
  defaultTtsModel,
  defaultTtsVoice,
  estimateTokens,
  guardNarrationText,
  hardMaxNarrationChars,
  normalizeNarrationText,
  pcmToWav,
} from "./core/tts.js";

export interface NarrationOptions {
  text: string;
  output?: string;
  model?: string;
  voice?: string;
  maxChars?: number;
  language?: string;
  style?: string;
  exact?: boolean;
  includeAudio?: boolean;
}

export interface NarrationResult {
  output: string;
  bytes: number;
  characters: number;
  estimatedInputTokens: number;
  model: string;
  voice: string;
  style?: string;
  exact: boolean;
  api: "tts";
  mimeType: "audio/wav";
  audioBase64?: string;
}

function resolveTtsRequest(options: NarrationOptions) {
  const text = normalizeNarrationText(options.text);
  guardNarrationText(text, options.maxChars);
  return {
    text,
    model: options.model ?? (process.env.GEMINI_TTS_MODEL?.trim() || defaultTtsModel),
    voice: options.voice ?? (process.env.GEMINI_TTS_VOICE?.trim() || defaultTtsVoice),
    language: options.language ?? process.env.VOICE_LANGUAGE ?? "en-US",
    style: options.style?.trim() || undefined,
    exact: options.exact !== false,
  };
}

export async function generateNarrationPcm(
  apiKey: string,
  options: NarrationOptions,
  provider: TtsProvider = new GeminiTtsProvider(apiKey),
): Promise<Buffer> {
  const request = resolveTtsRequest(options);
  const synthesis = await provider.synthesize(request);
  return synthesis.pcm;
}

export async function narrateText(
  apiKey: string,
  options: NarrationOptions,
  provider: TtsProvider = new GeminiTtsProvider(apiKey),
): Promise<NarrationResult> {
  const request = resolveTtsRequest(options);
  const output = resolve(options.output ?? defaultNarrationOutput);
  const synthesis = await provider.synthesize(request);
  const wav = pcmToWav(synthesis.pcm, synthesis.sampleRate);

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, wav);

  return {
    output,
    bytes: wav.length,
    characters: request.text.length,
    estimatedInputTokens: estimateTokens(request.text),
    model: synthesis.model,
    voice: synthesis.voice,
    style: request.style,
    exact: request.exact,
    api: "tts",
    mimeType: "audio/wav",
    ...(options.includeAudio === false ? {} : { audioBase64: wav.toString("base64") }),
  };
}
