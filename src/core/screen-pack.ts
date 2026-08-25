export const videoPacks = ["current", "motion", "motion-strip"] as const;
export type VideoPack = (typeof videoPacks)[number];
export const defaultVideoPack = "motion";
export const motionSampleMs = 330;
export const motionHistoryFrames = 3;
export const motionTintThreshold = 28;
export const motionTintMix = 0.3;

export function isVideoPack(value: unknown): value is VideoPack {
  return typeof value === "string" && (videoPacks as readonly string[]).includes(value);
}

export function parseVideoPack(value: unknown): VideoPack {
  return isVideoPack(value) ? value : defaultVideoPack;
}

export function lumaStats(data: Uint8ClampedArray): { mean: number; variance: number } {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    const luma = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    sum += luma;
    sumSq += luma * luma;
    count += 1;
  }
  if (count === 0) return { mean: 0, variance: 0 };
  const mean = sum / count;
  return { mean, variance: Math.max(0, sumSq / count - mean * mean) };
}

export function isBlankRgba(data: Uint8ClampedArray): boolean {
  const { mean, variance } = lumaStats(data);
  return mean < 18 && variance < 50;
}

export function applyMotionTint(
  current: Uint8ClampedArray,
  previousFrames: Uint8ClampedArray[],
  options?: { threshold?: number; mix?: number },
): { pixels: Uint8ClampedArray; movingPixels: number } {
  const threshold = options?.threshold ?? motionTintThreshold;
  const mix = options?.mix ?? motionTintMix;
  const pixels = new Uint8ClampedArray(current);
  if (previousFrames.length === 0) return { pixels, movingPixels: 0 };

  let movingPixels = 0;
  for (let index = 0; index < current.length; index += 4) {
    let delta = 0;
    for (const previous of previousFrames) {
      delta = Math.max(
        delta,
        Math.abs(current[index] - previous[index]),
        Math.abs(current[index + 1] - previous[index + 1]),
        Math.abs(current[index + 2] - previous[index + 2]),
      );
    }
    if (delta <= threshold) continue;
    movingPixels += 1;
    pixels[index] = current[index] * (1 - mix) + 255 * mix;
    pixels[index + 1] = current[index + 1] * (1 - mix) + 48 * mix;
    pixels[index + 2] = current[index + 2] * (1 - mix) + 168 * mix;
  }

  return { pixels, movingPixels };
}

export function buildVisionPackInstruction(pack: VideoPack = defaultVideoPack): string {
  const shared = [
    "If the JPEG is dark, blank, tiny, or unreadable, say you cannot see the screen. Then stop.",
    "Do not invent windows, apps, files, code, or tools. Do not ask if the user has a program unless they named it or it is clearly readable.",
    "Do not inventory left to right. Do not list every icon.",
  ];

  if (pack === "current") return shared.join(" ");

  const motion = [
    "The large panel is the current screenshot; read text from that, not from memory.",
    "Magenta/pink tint is recent motion (cursor, caret, scroll, new UI). Treat it as attention, not as extra objects.",
  ];

  if (pack === "motion-strip") {
    motion.push("The bottom strip is older→newer thumbnails of those samples.");
  }

  return [...motion, ...shared].join(" ");
}
