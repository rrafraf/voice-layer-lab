import { GoogleGenAI, Type } from "@google/genai";
import {
  buildVisionMapPrompt,
  defaultVisionModel,
  parseVisionMap,
  type VisionMap,
} from "../core/vision-map.js";
import { errText, trace } from "../trace.js";

export class GeminiVisionMapProvider {
  readonly name = "gemini-vision-map";

  constructor(private readonly apiKey: string) {}

  async mapFrame(imageBase64: string, mimeType = "image/jpeg", model = defaultVisionModel): Promise<VisionMap> {
    const started = Date.now();
    trace.debug("gemini.vision", "map.begin", `model=${model} b64=${imageBase64.length} mime=${mimeType}`);
    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            parts: [
              { text: buildVisionMapPrompt() },
              { inlineData: { mimeType, data: imageBase64 } },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              scene: { type: Type.STRING },
              objects: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    label: { type: Type.STRING },
                    kind: { type: Type.STRING },
                    x: { type: Type.NUMBER },
                    y: { type: Type.NUMBER },
                    w: { type: Type.NUMBER },
                    h: { type: Type.NUMBER },
                  },
                  required: ["label", "kind", "x", "y", "w", "h"],
                },
              },
            },
            required: ["scene", "objects"],
          },
        },
      });

      const text = response.text;
      if (!text) throw new Error("Vision map returned no JSON.");
      const map = parseVisionMap(JSON.parse(text));
      trace.info("gemini.vision", "map.ok", `ms=${Date.now() - started} objects=${map.objects.length}`);
      return map;
    } catch (error) {
      trace.error("gemini.vision", "map.fail", `ms=${Date.now() - started} ${errText(error)}`);
      throw error;
    }
  }
}
