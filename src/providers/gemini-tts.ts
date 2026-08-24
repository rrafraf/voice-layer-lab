import { GoogleGenAI, Modality } from "@google/genai";
import { buildTtsContents } from "../core/tts.js";
import type { TtsProvider, TtsRequest, TtsSynthesis } from "../core/types.js";

export class GeminiTtsProvider implements TtsProvider {
  readonly name = "gemini-tts";

  constructor(private readonly apiKey: string) {}

  async synthesize(request: TtsRequest): Promise<TtsSynthesis> {
    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    const response = await ai.models.generateContent({
      model: request.model,
      contents: [
        {
          parts: [
            {
              text: buildTtsContents({
                text: request.text,
                style: request.style,
                exact: request.exact,
              }),
            },
          ],
        },
      ],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: request.voice,
            },
          },
          languageCode: request.language,
        },
      },
    });

    const inlineData = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData;
    if (!inlineData?.data) throw new Error("Gemini TTS returned no inline audio data.");

    return {
      pcm: Buffer.from(inlineData.data, "base64"),
      sampleRate: 24000,
      model: request.model,
      voice: request.voice,
    };
  }
}
