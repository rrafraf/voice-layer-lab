import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const TRACE_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type TraceLevel = (typeof TRACE_LEVELS)[number];
export type TraceOrigin = "srv" | "ui";

export const LEVEL_WEIGHT: Record<TraceLevel | "ok", number> = {
  trace: 10,
  debug: 20,
  info: 30,
  ok: 30,
  warn: 40,
  error: 50,
};

export const LEVEL_TAG: Record<TraceLevel, string> = {
  trace: "TRC",
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

export interface TraceRecord {
  seq: number;
  at: string;
  lvl: TraceLevel;
  src: string;
  msg: string;
  data?: string;
  origin: TraceOrigin;
}

const MAX_BUFFER = 4000;
const records: TraceRecord[] = [];
let nextSeq = 1;
let consoleMin = LEVEL_WEIGHT[normalizeLevel(process.env.LOG_LEVEL, "trace")];

const logFile =
  process.env.VOICE_TRACE_FILE === "0"
    ? undefined
    : join(process.cwd(), process.env.VOICE_TRACE_FILE || "logs/voice-layer.log");

if (logFile) mkdirSync(dirname(logFile), { recursive: true });

type TraceListener = (record: TraceRecord) => void;
const listeners = new Set<TraceListener>();

export function normalizeLevel(value: unknown, fallback: TraceLevel = "trace"): TraceLevel {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "ok") return "info";
  return (TRACE_LEVELS as readonly string[]).includes(raw) ? (raw as TraceLevel) : fallback;
}

export function matchesTraceSrc(src: string, filter?: string | null): boolean {
  if (!filter) return true;
  return src === filter || src.startsWith(`${filter}.`);
}

export function formatTraceLine(record: TraceRecord): string {
  const time = record.at.slice(11, 23).padEnd(12, "0");
  const src = record.src.length >= 14 ? record.src : record.src.padEnd(14);
  const data = record.data ? `  ${record.data}` : "";
  return `${time}  ${LEVEL_TAG[record.lvl]}  ${src}  ${record.msg}${data}`;
}

export function errText(error: unknown): string {
  if (error instanceof Error) {
    const where = error.stack?.split("\n")[1]?.trim();
    return where ? `${error.message} | ${where}` : error.message;
  }
  return String(error);
}

export function onTrace(listener: TraceListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function writeTrace(input: {
  level?: string;
  src: string;
  msg: string;
  data?: string;
  origin?: TraceOrigin;
  at?: string;
}): TraceRecord {
  const record: TraceRecord = {
    seq: nextSeq++,
    at: input.at ?? new Date().toISOString(),
    lvl: normalizeLevel(input.level, "info"),
    src: String(input.src || "app").slice(0, 48),
    msg: String(input.msg || "").slice(0, 240),
    origin: input.origin ?? "srv",
  };
  if (input.data) record.data = String(input.data).slice(0, 800);

  records.push(record);
  if (records.length > MAX_BUFFER) records.splice(0, records.length - MAX_BUFFER);

  if (logFile) {
    try {
      appendFileSync(logFile, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // Logger must never throw.
    }
  }

  if (LEVEL_WEIGHT[record.lvl] >= consoleMin) {
    const line = formatTraceLine(record);
    if (record.lvl === "error") console.error(line);
    else if (record.lvl === "warn") console.warn(line);
    else console.log(line);
  }

  for (const listener of listeners) {
    try {
      listener(record);
    } catch {
      // Ignore subscriber failures.
    }
  }

  return record;
}

export const trace = {
  trace: (src: string, msg: string, data?: string) => writeTrace({ level: "trace", src, msg, data }),
  debug: (src: string, msg: string, data?: string) => writeTrace({ level: "debug", src, msg, data }),
  info: (src: string, msg: string, data?: string) => writeTrace({ level: "info", src, msg, data }),
  warn: (src: string, msg: string, data?: string) => writeTrace({ level: "warn", src, msg, data }),
  error: (src: string, msg: string, data?: string) => writeTrace({ level: "error", src, msg, data }),
};

export function getTraceTail(afterSeq = 0, minLevel: TraceLevel = "trace", origin?: TraceOrigin): TraceRecord[] {
  const min = LEVEL_WEIGHT[minLevel];
  return records.filter(
    (record) =>
      record.seq > afterSeq &&
      LEVEL_WEIGHT[record.lvl] >= min &&
      (origin ? record.origin === origin : true),
  );
}

export function getTraceMeta(): {
  file: string | null;
  consoleLevel: TraceLevel;
  seq: number;
  count: number;
} {
  const consoleLevel = TRACE_LEVELS.find((level) => LEVEL_WEIGHT[level] === consoleMin) ?? "trace";
  return {
    file: logFile ?? null,
    consoleLevel,
    seq: nextSeq - 1,
    count: records.length,
  };
}

export function setConsoleLevel(level: TraceLevel): void {
  consoleMin = LEVEL_WEIGHT[level];
}

export function ingestUiTraces(entries: unknown): number {
  if (!Array.isArray(entries)) return 0;
  let count = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.msg !== "string" && typeof row.event !== "string") continue;
    writeTrace({
      level: typeof row.lvl === "string" ? row.lvl : typeof row.level === "string" ? row.level : "info",
      src: typeof row.src === "string" ? row.src : "ui",
      msg: typeof row.msg === "string" ? row.msg : String(row.event),
      data: typeof row.data === "string" ? row.data : typeof row.detail === "string" ? row.detail : undefined,
      at: typeof row.at === "string" ? row.at : undefined,
      origin: "ui",
    });
    count += 1;
  }
  return count;
}
