import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import open from "open";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig, type AppConfig } from "./config.js";
import { describeTtsApi } from "./core/tts.js";
import { defaultLiveVoice, describeLiveApi, parseLiveClientMessage, type LiveMode } from "./core/live.js";
import { defaultVideoPack, type VideoPack } from "./core/screen-pack.js";
import type { VoiceEvent } from "./core/types.js";
import { narrateText } from "./narration.js";
import { GeminiLiveProvider } from "./providers/gemini-live.js";
import { GeminiTtsProvider } from "./providers/gemini-tts.js";
import { GeminiVisionMapProvider } from "./providers/gemini-vision-map.js";
import {
  errText,
  getTraceMeta,
  getTraceTail,
  ingestUiTraces,
  normalizeLevel,
  setConsoleLevel,
  trace,
} from "./trace.js";
import { VoiceSessionState } from "./voice-session-state.js";

trace.info("boot", "process", `node=${process.version} pid=${process.pid} cwd=${process.cwd()}`);

let config: AppConfig | undefined;
try {
  config = loadConfig();
  trace.info(
    "boot",
    "config.ok",
    `mode=${config.mode} model=${config.model} lang=${config.language} key=set`,
  );
} catch (error) {
  trace.error("boot", "config.fail", errText(error));
}

const ttsProvider = config ? new GeminiTtsProvider(config.apiKey) : undefined;
const visionMapProvider = config ? new GeminiVisionMapProvider(config.apiKey) : undefined;
const port = Number(process.env.VOICE_UI_PORT ?? 4317);
const publicDir = join(process.cwd(), "public");
let nextSessionId = 1;
const voiceState = new VoiceSessionState();

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function missingKey(): string {
  return "GEMINI_API_KEY missing. Server is up in trace-only mode. Add the key to .env.local.";
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(JSON.stringify(payload));
}

function readRequestJson(request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8").trim();
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function broadcastControl(action: "start" | "stop"): void {
  for (const socket of sockets.clients) sendJson(socket, { type: "control", action });
}

async function handleApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/api/")) return false;

  if (request.method === "OPTIONS") {
    writeJson(response, 204, {});
    return true;
  }

  const started = Date.now();
  const mark = (status: number, extra?: string) => {
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "debug";
    trace[level]("http", `${request.method} ${pathname}`, `status=${status} ms=${Date.now() - started}${extra ? ` ${extra}` : ""}`);
  };

  try {
    if (request.method === "GET" && pathname === "/api/trace") {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const after = Number(url.searchParams.get("after") ?? 0);
      const min = normalizeLevel(url.searchParams.get("min"), "trace");
      const origin = url.searchParams.get("origin");
      writeJson(response, 200, {
        ...getTraceMeta(),
        entries: getTraceTail(Number.isFinite(after) ? after : 0, min, origin === "ui" || origin === "srv" ? origin : undefined),
      });
      return true;
    }

    if (request.method === "POST" && pathname === "/api/trace") {
      const body = await readRequestJson(request, 256 * 1024);
      const entries = isRecord(body) && Array.isArray(body.entries) ? body.entries : Array.isArray(body) ? body : [];
      const count = ingestUiTraces(entries);
      writeJson(response, 200, { ok: true, ingested: count, ...getTraceMeta() });
      return true;
    }

    if (request.method === "POST" && pathname === "/api/trace/level") {
      const body = await readRequestJson(request);
      const level = isRecord(body) ? normalizeLevel(body.level, "trace") : "trace";
      setConsoleLevel(level);
      trace.info("trace", "console.level", level);
      writeJson(response, 200, { ok: true, level, ...getTraceMeta() });
      return true;
    }

    if (request.method === "GET" && pathname === "/api/status") {
      writeJson(response, 200, {
        ...voiceState.getStatus(sockets.clients.size),
        configOk: Boolean(config),
        trace: getTraceMeta(),
      });
      mark(200);
      return true;
    }

    if (request.method === "GET" && pathname === "/api/transcript") {
      writeJson(response, 200, voiceState.getTranscript());
      mark(200);
      return true;
    }

    if (request.method === "GET" && pathname === "/api/prompt") {
      writeJson(response, 200, { prompt: voiceState.formatCursorPrompt() });
      mark(200);
      return true;
    }

    if (request.method === "POST" && pathname === "/api/transcript/clear") {
      voiceState.clearTranscript();
      writeJson(response, 200, voiceState.getTranscript());
      mark(200);
      return true;
    }

    if (request.method === "POST" && pathname === "/api/control/start") {
      voiceState.requestStart();
      broadcastControl("start");
      trace.info("ctrl", "start", `clients=${sockets.clients.size}`);
      writeJson(response, 200, voiceState.getStatus(sockets.clients.size));
      mark(200);
      return true;
    }

    if (request.method === "POST" && pathname === "/api/control/stop") {
      voiceState.requestStop();
      broadcastControl("stop");
      trace.info("ctrl", "stop", `clients=${sockets.clients.size}`);
      writeJson(response, 200, voiceState.getStatus(sockets.clients.size));
      mark(200);
      return true;
    }

    if (request.method === "GET" && pathname === "/api/live") {
      writeJson(response, 200, {
        ...describeLiveApi(),
        language: config?.language ?? "en-US",
      });
      mark(200);
      return true;
    }

    if (request.method === "GET" && pathname === "/api/tts") {
      writeJson(response, 200, {
        ...describeTtsApi(),
        defaultModel: config?.ttsModel,
        defaultVoice: config?.ttsVoice,
        language: config?.language ?? "en-US",
      });
      mark(200);
      return true;
    }

    if (request.method === "POST" && pathname === "/api/narrate") {
      if (!config || !ttsProvider) {
        writeJson(response, 503, { error: missingKey() });
        mark(503);
        return true;
      }
      const body = await readRequestJson(request);
      if (!isRecord(body) || typeof body.text !== "string") {
        writeJson(response, 400, { error: "Request JSON must include a text string." });
        mark(400);
        return true;
      }

      trace.info("tts", "narrate.req", `chars=${body.text.length} voice=${typeof body.voice === "string" ? body.voice : config.ttsVoice}`);
      const result = await narrateText(
        config.apiKey,
        {
          text: body.text,
          output: typeof body.output === "string" ? body.output : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          voice: typeof body.voice === "string" ? body.voice : undefined,
          maxChars: typeof body.maxChars === "number" ? body.maxChars : undefined,
          style: typeof body.style === "string" ? body.style : undefined,
          exact: body.exact === false ? false : true,
          includeAudio: body.includeAudio === false ? false : true,
          language: config.language,
        },
        ttsProvider,
      );
      trace.info("tts", "narrate.ok", `bytes=${result.bytes} voice=${result.voice}`);
      writeJson(response, 200, result);
      mark(200, `chars=${body.text.length}`);
      return true;
    }

    if (request.method === "POST" && pathname === "/api/vision-map") {
      if (!config || !visionMapProvider) {
        writeJson(response, 503, { error: missingKey() });
        mark(503);
        return true;
      }
      const body = await readRequestJson(request, 900 * 1024);
      if (!isRecord(body) || typeof body.image !== "string" || !body.image.trim()) {
        writeJson(response, 400, { error: "Request JSON must include a base64 image string." });
        mark(400);
        return true;
      }
      trace.debug("vision", "map.req", `b64=${body.image.length}`);
      const map = await visionMapProvider.mapFrame(
        body.image.replace(/^data:image\/\w+;base64,/, ""),
        typeof body.mimeType === "string" ? body.mimeType : "image/jpeg",
      );
      trace.info("vision", "map.ok", `objects=${map.objects.length} scene=${map.scene.slice(0, 80)}`);
      writeJson(response, 200, map);
      mark(200);
      return true;
    }

    writeJson(response, 404, { error: "API route not found." });
    mark(404);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace.error("http", `${request.method} ${pathname}`, errText(error));
    writeJson(response, 500, { error: message });
    return true;
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  void handleApi(request, response, url.pathname).then((handled) => {
    if (handled) return;

    const pathname = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(publicDir, safePath);

    if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
      trace.warn("http", "static.404", url.pathname);
      response.writeHead(404).end("Not found");
      return;
    }

    trace.trace("http", "static", pathname);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  }).catch((error: unknown) => {
    trace.error("http", "request.fail", errText(error));
    if (!response.headersSent) response.writeHead(500).end("Internal error");
  });
});

const sockets = new WebSocketServer({ server, path: "/voice" });

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function forwardEvent(socket: WebSocket, event: VoiceEvent, session: string): void {
  voiceState.handleEvent(event);

  if (event.type === "output_audio") {
    trace.trace("gemini", "audio.out", `sess=${session} bytes=${event.data.length} hz=${event.sampleRate}`);
    if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
    return;
  }

  if (event.type === "error") {
    trace.error("gemini", "event.err", `sess=${session} ${event.error.message}`);
    sendJson(socket, { type: event.type, message: event.error.message });
    return;
  }

  if (event.type === "connected") trace.info("gemini", "event.connected", `sess=${session} provider=${event.provider}`);
  else if (event.type === "closed") trace.warn("gemini", "event.closed", `sess=${session} ${event.reason ?? ""}`);
  else if (event.type === "turn_complete") trace.debug("gemini", "turn.complete", `sess=${session}`);
  else if (event.type === "interrupted") trace.debug("gemini", "turn.interrupt", `sess=${session}`);
  else if (event.type === "input_transcript") trace.trace("gemini", "tx.in", `sess=${session} n=${event.text.length}`);
  else if (event.type === "output_transcript") trace.trace("gemini", "tx.out", `sess=${session} n=${event.text.length}`);
  else if (event.type === "input_prompt") trace.debug("gemini", "prompt.fwd", `sess=${session} n=${event.text.length}`);

  sendJson(socket, event);
}

sockets.on("connection", (socket, request) => {
  const session = `voice-${nextSessionId++}`;
  voiceState.setSession(session);
  trace.info("ws", "open", `sess=${session} clients=${sockets.clients.size} ua=${request.headers["user-agent"] ?? "?"}`);
  sendJson(socket, { type: "status", ...voiceState.getStatus(sockets.clients.size) });
  sendJson(socket, { type: "phase", level: "ok", message: "Browser reached local server" });

  if (!config) {
    trace.error("ws", "no.config", `sess=${session}`);
    sendJson(socket, { type: "error", message: missingKey() });
  }

  let provider: GeminiLiveProvider | undefined;
  let providerReady = false;
  let reportedEarlyAudio = false;
  let videoFrames = 0;
  let audioChunks = 0;
  let starting: Promise<void> | undefined;
  let liveMode: LiveMode = config?.mode === "transcribe" ? "transcribe" : "conversation";
  let liveStyle: string | undefined;
  let liveVoice = defaultLiveVoice;
  let liveVideoPack: VideoPack = defaultVideoPack;

  const ensureProvider = (): Promise<void> => {
    const cfg = config;
    if (!cfg) return Promise.reject(new Error(missingKey()));
    starting ??= (async () => {
      provider = new GeminiLiveProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        language: cfg.language,
        mode: liveMode,
        style: liveStyle,
        voice: liveVoice,
        videoPack: liveVideoPack,
      });
      trace.info("gemini", "connecting", `sess=${session} ${liveMode}/${liveVoice} pack=${liveVideoPack}`);
      sendJson(socket, { type: "phase", level: "info", message: `Connecting to Gemini Live (${liveMode})` });
      await provider.connect((event) => forwardEvent(socket, event, session));
      providerReady = true;
      trace.info("gemini", "connected", `sess=${session}`);
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      trace.error("gemini", "connect.fail", `sess=${session} ${errText(error)}`);
      sendJson(socket, { type: "error", message });
      socket.close(1011, "Gemini connection failed");
      throw error;
    });
    return starting;
  };

  socket.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const message = parseLiveClientMessage(data.toString());
        if (message.type === "session") {
          trace.info("ws", "session", `sess=${session} ${message.mode}/${message.voice} pack=${message.videoPack}`);
          if (starting) {
            sendJson(socket, {
              type: "phase",
              level: "info",
              message: "Mode, voice, and style already applied. Stop and start to change them. Text prompts still steer this session.",
            });
            return;
          }
          liveMode = message.mode;
          liveStyle = message.style;
          liveVoice = message.voice;
          liveVideoPack = message.videoPack;
          void ensureProvider().catch(() => undefined);
          return;
        }
        void ensureProvider()
          .then(() => {
            if (!providerReady || !provider) return;
            if (message.type === "text") {
              provider.sendText(message.text);
              trace.info("ws", "prompt", `sess=${session} chars=${message.text.length}`);
              return;
            }
            provider.sendVideo(message.data, message.mimeType);
            voiceState.noteVideoFrame();
            videoFrames += 1;
            trace.debug("ws", "video", `sess=${session} bytes=${message.data.length} frame=${videoFrames}`);
          })
          .catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Not a live client message") {
          trace.trace("ws", "text.ignore", `sess=${session}`);
          return;
        }
        trace.error("ws", "text.fail", `sess=${session} ${message}`);
        sendJson(socket, { type: "error", message });
      }
      return;
    }

    audioChunks += 1;
    if (audioChunks === 1 || audioChunks % 25 === 0) {
      trace.trace("ws", "audio.in", `sess=${session} n=${audioChunks} bytes=${(data as Buffer).length}`);
    }

    if (!providerReady || !provider) {
      if (!reportedEarlyAudio) {
        reportedEarlyAudio = true;
        trace.info("ws", "audio.wait", `sess=${session}`);
        sendJson(socket, { type: "phase", level: "info", message: "Microphone ready; waiting for Gemini" });
      }
      void ensureProvider().catch(() => undefined);
      return;
    }

    try {
      provider.sendAudio(Buffer.from(data as Buffer));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace.error("ws", "audio.fail", `sess=${session} ${message}`);
      sendJson(socket, { type: "error", message });
    }
  });
  socket.once("close", (code, reason) => {
    trace.info("ws", "close", `sess=${session} code=${code}${reason.length ? ` reason=${reason.toString()}` : ""}`);
    if (sockets.clients.size <= 1) voiceState.requestStop();
    void provider?.close();
  });
  socket.once("error", (error) => {
    trace.error("ws", "sock.err", `sess=${session} ${error.message}`);
    void provider?.close();
  });
});

server.on("error", (error) => {
  trace.error("boot", "listen.fail", errText(error));
});

server.listen(port, "127.0.0.1", async () => {
  const url = `http://127.0.0.1:${port}`;
  const meta = getTraceMeta();
  trace.info("boot", "listen", `${url} file=${meta.file ?? "off"}`);
  console.log(`Voice Layer Lab is ready at ${url}`);
  console.log(`Trace file: ${meta.file ?? "(disabled)"}`);
  if (!config) console.log("Trace-only mode: GEMINI_API_KEY is missing.");
  if (process.env.VOICE_UI_OPEN !== "0") await open(url);
});

async function shutdown(): Promise<void> {
  trace.info("boot", "shutdown", "signal");
  for (const socket of sockets.clients) socket.close();
  sockets.close();
  server.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.on("uncaughtException", (error) => {
  trace.error("boot", "uncaught", errText(error));
});
process.on("unhandledRejection", (reason) => {
  trace.error("boot", "unhandledRejection", errText(reason));
});
