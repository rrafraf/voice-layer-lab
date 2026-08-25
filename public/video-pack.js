const MOTION_THRESHOLD = 28;
const MOTION_MIX = 0.3;
const STRIP_RATIO = 0.2;

function cloneImageData(frame) {
  return new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
}

export function lumaStats(data) {
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

export function isBlankFrame(frame) {
  const { mean, variance } = lumaStats(frame.data);
  return mean < 18 && variance < 50;
}

function liftContrast(frame, amount = 1.06) {
  const next = cloneImageData(frame);
  const data = next.data;
  for (let index = 0; index < data.length; index += 4) {
    data[index] = Math.max(0, Math.min(255, (data[index] - 128) * amount + 128));
    data[index + 1] = Math.max(0, Math.min(255, (data[index + 1] - 128) * amount + 128));
    data[index + 2] = Math.max(0, Math.min(255, (data[index + 2] - 128) * amount + 128));
  }
  return next;
}

function applyMotionTint(current, previousFrames) {
  const next = cloneImageData(current);
  if (!previousFrames.length) return next;
  const pixels = next.data;
  const now = current.data;
  for (let index = 0; index < now.length; index += 4) {
    let delta = 0;
    for (const previous of previousFrames) {
      const older = previous.data;
      delta = Math.max(
        delta,
        Math.abs(now[index] - older[index]),
        Math.abs(now[index + 1] - older[index + 1]),
        Math.abs(now[index + 2] - older[index + 2]),
      );
    }
    if (delta <= MOTION_THRESHOLD) continue;
    pixels[index] = now[index] * (1 - MOTION_MIX) + 255 * MOTION_MIX;
    pixels[index + 1] = now[index + 1] * (1 - MOTION_MIX) + 48 * MOTION_MIX;
    pixels[index + 2] = now[index + 2] * (1 - MOTION_MIX) + 168 * MOTION_MIX;
  }
  return next;
}

function drawLabeledThumb(context, frame, x, y, width, height, label) {
  context.fillStyle = "#070b10";
  context.fillRect(x, y, width, height);
  const scale = Math.min(width / frame.width, (height - 16) / frame.height);
  const drawWidth = Math.max(1, frame.width * scale);
  const drawHeight = Math.max(1, frame.height * scale);
  const scratch = document.createElement("canvas");
  scratch.width = frame.width;
  scratch.height = frame.height;
  scratch.getContext("2d").putImageData(frame, 0, 0);
  context.drawImage(
    scratch,
    x + (width - drawWidth) / 2,
    y + 16,
    drawWidth,
    drawHeight,
  );
  context.fillStyle = "#d7e2ee";
  context.font = "11px ui-sans-serif, sans-serif";
  context.fillText(label, x + 8, y + 12);
}

export function composeScreenFrame(frames, pack = "motion", maxEdge = 1280) {
  if (!frames.length) return undefined;
  const latest = frames[frames.length - 1];
  const previous = frames.slice(0, -1);
  const readable = pack === "current" ? latest : liftContrast(latest);
  const main = pack === "current" ? readable : applyMotionTint(readable, previous);
  const includeStrip = pack === "motion-strip";
  const stripHeight = includeStrip ? Math.max(72, Math.round(main.height * STRIP_RATIO)) : 0;
  let width = main.width;
  let height = main.height + stripHeight;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.scale(scale, scale);
  context.fillStyle = "#0b1118";
  context.fillRect(0, 0, main.width, main.height + stripHeight);

  const scratch = document.createElement("canvas");
  scratch.width = main.width;
  scratch.height = main.height;
  scratch.getContext("2d").putImageData(main, 0, 0);
  context.drawImage(scratch, 0, 0);

  if (includeStrip) {
    const cellWidth = main.width / Math.max(1, frames.length);
    const stripTop = main.height;
    frames.forEach((frame, index) => {
      const label = index === frames.length - 1 ? "now" : `t-${frames.length - 1 - index}`;
      drawLabeledThumb(context, frame, index * cellWidth, stripTop, cellWidth, stripHeight, label);
    });
  }

  return canvas;
}

export function videoPackLabel(pack) {
  if (pack === "motion-strip") return "motion tint + strip";
  if (pack === "motion") return "motion tint";
  return "current frame";
}
