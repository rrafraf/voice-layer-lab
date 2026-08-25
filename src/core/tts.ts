export const hardMaxNarrationChars = 2000;
export const defaultTtsModel = "gemini-3.1-flash-tts-preview";
export const defaultTtsVoice = "Kore";
export const defaultNarrationOutput = "runs/voice-narration.wav";
export const ttsSampleRate = 24000 as const;

export const ttsModels = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
] as const;

export const ttsVoices = [
  { name: "Kore", description: "Firm" },
  { name: "Puck", description: "Upbeat" },
  { name: "Charon", description: "Informative" },
  { name: "Zephyr", description: "Bright" },
  { name: "Fenrir", description: "Excitable" },
  { name: "Leda", description: "Youthful" },
  { name: "Orus", description: "Firm" },
  { name: "Aoede", description: "Breezy" },
  { name: "Callirrhoe", description: "Easy-going" },
  { name: "Autonoe", description: "Bright" },
  { name: "Enceladus", description: "Breathy" },
  { name: "Iapetus", description: "Clear" },
  { name: "Umbriel", description: "Easy-going" },
  { name: "Algieba", description: "Smooth" },
  { name: "Despina", description: "Smooth" },
  { name: "Erinome", description: "Clear" },
  { name: "Algenib", description: "Gravelly" },
  { name: "Rasalgethi", description: "Informative" },
  { name: "Laomedeia", description: "Upbeat" },
  { name: "Achernar", description: "Soft" },
  { name: "Alnilam", description: "Firm" },
  { name: "Schedar", description: "Even" },
  { name: "Gacrux", description: "Mature" },
  { name: "Pulcherrima", description: "Forward" },
  { name: "Achird", description: "Friendly" },
  { name: "Zubenelgenubi", description: "Casual" },
  { name: "Vindemiatrix", description: "Gentle" },
  { name: "Sadachbia", description: "Lively" },
  { name: "Sadaltager", description: "Knowledgeable" },
  { name: "Sulafat", description: "Warm" },
] as const;

export interface TtsPromptOptions {
  text: string;
  style?: string;
  exact?: boolean;
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

export function buildTtsContents(options: TtsPromptOptions): string {
  const text = normalizeNarrationText(options.text);
  const style = options.style?.trim();
  const exact = options.exact !== false;
  const lines = exact
    ? [
        "Recite the following text exactly.",
        "Do not add commentary, explanations, greetings, summaries, or extra words.",
      ]
    : ["Read the following text aloud."];

  if (style) lines.push(`Delivery style: ${style}`);
  lines.push("", text);
  return lines.join("\n");
}

export function pcmToWav(pcm: Buffer, sampleRate = ttsSampleRate, channels = 1, bitsPerSample = 16): Buffer {
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

export function describeTtsApi() {
  return {
    kind: "tts" as const,
    transport: "request-response" as const,
    description:
      "Gemini TTS recites explicit text with optional style control. It is not the Live API and does not stream microphone or video.",
    live: {
      kind: "live" as const,
      transport: "bidirectional-native-audio" as const,
      description:
        "Gemini Live is the low-latency interactive path: microphone audio, optional JPEG video, mid-session text prompts, barge-in, and spoken audio out with transcripts.",
    },
    models: [...ttsModels],
    voices: ttsVoices.map((voice) => ({ ...voice })),
    defaultModel: defaultTtsModel,
    defaultVoice: defaultTtsVoice,
    maxChars: hardMaxNarrationChars,
    sampleRate: ttsSampleRate,
  };
}
