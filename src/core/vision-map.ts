export const visionKinds = [
  "window",
  "button",
  "input",
  "text",
  "cursor",
  "dialog",
  "error",
  "other",
] as const;
export type VisionKind = (typeof visionKinds)[number];
export const maxVisionObjects = 12;
export const defaultVisionModel = "gemini-2.5-flash";

export interface VisionObject {
  label: string;
  kind: VisionKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisionMap {
  scene: string;
  objects: VisionObject[];
}

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function isVisionKind(value: unknown): value is VisionKind {
  return typeof value === "string" && (visionKinds as readonly string[]).includes(value);
}

export function parseVisionMap(payload: unknown): VisionMap {
  if (!isRecord(payload)) throw new Error("Vision map must be an object.");
  const scene = typeof payload.scene === "string" ? payload.scene.trim() : "";
  const rows = Array.isArray(payload.objects) ? payload.objects : [];
  const objects: VisionObject[] = [];

  for (const row of rows) {
    if (!isRecord(row) || typeof row.label !== "string") continue;
    const label = row.label.trim();
    if (!label) continue;
    objects.push({
      label: label.slice(0, 80),
      kind: isVisionKind(row.kind) ? row.kind : "other",
      x: clampUnit(Number(row.x)),
      y: clampUnit(Number(row.y)),
      w: clampUnit(Number(row.w)),
      h: clampUnit(Number(row.h)),
    });
    if (objects.length >= maxVisionObjects) break;
  }

  return { scene: scene.slice(0, 240), objects };
}

export function formatVisionMapTable(map: VisionMap): string {
  if (!map.scene && map.objects.length === 0) return "No mapped objects yet.";
  const lines = [
    map.scene || "Scene",
    "",
    "| kind | label | x | y | w | h |",
    "| --- | --- | --- | --- | --- | --- |",
    ...map.objects.map(
      (object) =>
        `| ${object.kind} | ${object.label} | ${object.x.toFixed(2)} | ${object.y.toFixed(2)} | ${object.w.toFixed(2)} | ${object.h.toFixed(2)} |`,
    ),
  ];
  return lines.join("\n");
}

export function buildVisionMapPrompt(): string {
  return [
    "You are mapping a packed screenshot sent to Gemini Live.",
    "Magenta/pink tint marks recent motion (cursor, caret, scroll, new UI).",
    "Return JSON only.",
    "scene: one short line naming the focused app or window and what seems to be happening.",
    "objects: up to 12 important items with normalized bounding boxes 0-1 of the full image.",
    "Prefer the focused window, cursor, dialogs, errors, buttons near the cursor, and selected text.",
    "Do not inventory every icon. Do not invent UI you cannot read.",
  ].join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
