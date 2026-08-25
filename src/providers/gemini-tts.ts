import { GoogleGenAI, Modality } from "@google/genai";
import { buildTtsContents } from "../core/tts.js";
import type { TtsProvider, TtsRequest, TtsSynthesis } from "../core/types.js";
import { errText, trace } from "../trace.js";

export class GeminiTtsProvider implements TtsProvider {
  readonly name = "gemini-tts";

  constructor(private readonly apiKey: string) {}

  async synthesize(request: TtsRequest): Promise<TtsSynthesis> {
    const started = Date.now();
    trace.debug("gemini.tts", "synth.begin", `model=${request.model} voice=${request.voice} chars=${request.text.length}`);
    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    try {
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

      const pcm = Buffer.from(inlineData.data, "base64");
      trace.info("gemini.tts", "synth.ok", `ms=${Date.now() - started} pcm=${pcm.length}`);
      return {
        pcm,
        sampleRate: 24000,
        model: request.model,
        voice: request.voice,
      };
    } catch (error) {
      trace.error("gemini.tts", "synth.fail", `ms=${Date.now() - started} ${errText(error)}`);
      throw error;
    }
  }
}
