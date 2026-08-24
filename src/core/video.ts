export const videoFrameMimeType = "image/jpeg";
export const maxVideoFrameBytes = 512 * 1024;

export interface VideoFrame {
  data: Buffer;
  mimeType: typeof videoFrameMimeType;
}

export function parseRealtimeVideoMessage(raw: string): VideoFrame {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("Video frame message must be JSON.");
  }

  if (!isRecord(payload) || payload.type !== "video") {
    throw new Error("Not a video message");
  }

  if (payload.mimeType !== videoFrameMimeType) {
    throw new Error(`Only ${videoFrameMimeType} video frames are supported.`);
  }

  if (typeof payload.data !== "string" || payload.data.length === 0) {
    throw new Error("Video frame data is missing.");
  }

  const data = Buffer.from(payload.data, "base64");
  if (data.length === 0) throw new Error("Video frame is empty.");
  if (data.length > maxVideoFrameBytes) {
    throw new Error(`Video frame is ${data.length} bytes; max is ${maxVideoFrameBytes}.`);
  }

  return { data, mimeType: videoFrameMimeType };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
