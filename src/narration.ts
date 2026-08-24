import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { GoogleGenAI, Modality } from "@google/genai";

export const hardMaxNarrationChars = 2000;
export const defaultTtsModel = "gemini-2.5-flash-preview-tts";
export const defaultTtsVoice = "Kore";
export const defaultNarrationOutput = "runs/voice-narration.wav";

export interface NarrationOptions {
  text: string;
  output?: string;
  model?: string;
  voice?: string;
  maxChars?: number;
  language?: string;
}

export interface NarrationResult {
  output: string;
  bytes: number;
  characters: number;
  estimatedInputTokens: number;
  model: string;
  voice: string;
}

export function normalizeNarrationText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function guardNarrationText(text: string, maxChars = hardMaxNarrationChars): void {
  if (!text) throw new Error("No text was provided for narration.");
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > hardMaxNarrationChars) {
    throw new Error(`maxChars must be an integer from 1 to ${hardMaxNarrationChars}`);
  }
  if (text.length > maxChars) {
    throw new Error(`Narration text is ${text.length} characters; refusing to send more than ${maxChars}.`);
  }
}

export function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const headerSize = 44;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const wav = Buffer.alloc(headerSize + pcm.length);

  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, headerSize);

  return wav;
}

export async function generateNarrationPcm(apiKey: string, options: NarrationOptions): Promise<Buffer> {
  const text = normalizeNarrationText(options.text);
  guardNarrationText(text, options.maxChars);
  const model = options.model ?? (process.env.GEMINI_TTS_MODEL?.trim() || defaultTtsModel);
  const voice = options.voice ?? (process.env.GEMINI_TTS_VOICE?.trim() || defaultTtsVoice);

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        parts: [
          {
            text: [
              "Speak exactly the provided text.",
              "Do not add commentary, explanations, greetings, summaries, or extra words.",
              "",
              text,
            ].join("\n"),
          },
        ],
      },
    ],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice,
          },
        },
        languageCode: options.language ?? process.env.VOICE_LANGUAGE ?? "en-US",
      },
    },
  });

  const inlineData = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData;
  if (!inlineData?.data) throw new Error("Gemini returned no inline audio data.");

  return Buffer.from(inlineData.data, "base64");
}

export async function narrateText(apiKey: string, options: NarrationOptions): Promise<NarrationResult> {
  const text = normalizeNarrationText(options.text);
  guardNarrationText(text, options.maxChars);

  const model = options.model ?? (process.env.GEMINI_TTS_MODEL?.trim() || defaultTtsModel);
  const voice = options.voice ?? (process.env.GEMINI_TTS_VOICE?.trim() || defaultTtsVoice);
  const output = resolve(options.output ?? defaultNarrationOutput);
  const pcm = await generateNarrationPcm(apiKey, { ...options, text, model, voice });
  const wav = pcmToWav(pcm);

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, wav);

  return {
    output,
    bytes: wav.length,
    characters: text.length,
    estimatedInputTokens: estimateTokens(text),
    model,
    voice,
  };
}
