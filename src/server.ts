import { appendFileSync, createReadStream, existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import open from "open";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import type { VoiceEvent } from "./core/types.js";
import { parseRealtimeVideoMessage } from "./core/video.js";
import { narrateText } from "./narration.js";
import { GeminiLiveProvider } from "./providers/gemini-live.js";
import { VoiceSessionState } from "./voice-session-state.js";

const config = loadConfig();
const port = Number(process.env.VOICE_UI_PORT ?? 4317);
const publicDir = join(process.cwd(), "public");
const logDir = join(process.cwd(), "logs");
const logFile = join(logDir, "voice-layer.log");
mkdirSync(logDir, { recursive: true });
let nextSessionId = 1;
const voiceState = new VoiceSessionState();

function log(session: string, event: string, detail?: string): void {
  const entry = { at: new Date().toISOString(), session, event, ...(detail ? { detail } : {}) };
  appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
  console.log(`[${session}] ${event}${detail ? `: ${detail}` : ""}`);
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

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

  try {
    if (request.method === "GET" && pathname === "/api/status") {
      writeJson(response, 200, voiceState.getStatus(sockets.clients.size));
      return true;
    }

    if (request.method === "GET" && pathname === "/api/transcript") {
      writeJson(response, 200, voiceState.getTranscript());
      return true;
    }

    if (request.method === "GET" && pathname === "/api/prompt") {
      writeJson(response, 200, { prompt: voiceState.formatCursorPrompt() });
      return true;
    }

    if (request.method === "POST" && pathname === "/api/transcript/clear") {
      voiceState.clearTranscript();
      writeJson(response, 200, voiceState.getTranscript());
      return true;
    }

    if (request.method === "POST" && pathname === "/api/control/start") {
      voiceState.requestStart();
      broadcastControl("start");
      writeJson(response, 200, voiceState.getStatus(sockets.clients.size));
      return true;
    }

    if (request.method === "POST" && pathname === "/api/control/stop") {
      voiceState.requestStop();
      broadcastControl("stop");
      writeJson(response, 200, voiceState.getStatus(sockets.clients.size));
      return true;
    }

    if (request.method === "POST" && pathname === "/api/narrate") {
      const body = await readRequestJson(request);
      if (!isRecord(body) || typeof body.text !== "string") {
        writeJson(response, 400, { error: "Request JSON must include a text string." });
        return true;
      }

      const result = await narrateText(config.apiKey, {
        text: body.text,
        output: typeof body.output === "string" ? body.output : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
        voice: typeof body.voice === "string" ? body.voice : undefined,
        maxChars: typeof body.maxChars === "number" ? body.maxChars : undefined,
        language: config.language,
      });
      writeJson(response, 200, result);
      return true;
    }

    writeJson(response, 404, { error: "API route not found." });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
    response.writeHead(404).end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
  });
});

const sockets = new WebSocketServer({ server, path: "/voice" });

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function forwardEvent(socket: WebSocket, event: VoiceEvent): void {
  voiceState.handleEvent(event);

  if (event.type === "output_audio") {
    if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
    return;
  }

  if (event.type === "error") {
    sendJson(socket, { type: event.type, message: event.error.message });
    return;
  }

  sendJson(socket, event);
}

sockets.on("connection", async (socket) => {
  const session = `voice-${nextSessionId++}`;
  voiceState.setSession(session);
  log(session, "browser_connected");
  sendJson(socket, { type: "status", ...voiceState.getStatus(sockets.clients.size) });
  sendJson(socket, { type: "phase", level: "ok", message: "Browser reached local server" });
  const provider = new GeminiLiveProvider({
    apiKey: config.apiKey,
    model: config.model,
    language: config.language,
    behavior: config.mode,
  });
  let providerReady = false;
  let reportedEarlyAudio = false;
  let videoFrames = 0;

  socket.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const frame = parseRealtimeVideoMessage(data.toString());
        if (!providerReady) return;
        provider.sendVideo(frame.data, frame.mimeType);
        voiceState.noteVideoFrame();
        videoFrames += 1;
        if (videoFrames === 1 || videoFrames % 10 === 0) {
          log(session, "video_frame", `${frame.data.length} bytes frame=${videoFrames}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Not a video message") return;
        log(session, "video_send_failed", message);
        sendJson(socket, { type: "error", message });
      }
      return;
    }
    if (!providerReady) {
      if (!reportedEarlyAudio) {
        reportedEarlyAudio = true;
        log(session, "audio_waiting_for_gemini");
        sendJson(socket, { type: "phase", level: "info", message: "Microphone ready; waiting for Gemini" });
      }
      return;
    }
    try {
      provider.sendAudio(Buffer.from(data as Buffer));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(session, "audio_send_failed", message);
      sendJson(socket, { type: "error", message });
    }
  });
  socket.once("close", (code, reason) => {
    log(session, "browser_disconnected", `code=${code}${reason.length ? ` reason=${reason.toString()}` : ""}`);
    if (sockets.clients.size <= 1) voiceState.requestStop();
    void provider.close();
  });
  socket.once("error", (error) => {
    log(session, "browser_socket_error", error.message);
    void provider.close();
  });

  try {
    log(session, "gemini_connecting");
    sendJson(socket, { type: "phase", level: "info", message: "Connecting to Gemini Live" });
    await provider.connect((event) => forwardEvent(socket, event));
    providerReady = true;
    log(session, "gemini_connected");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(session, "gemini_connection_failed", message);
    sendJson(socket, { type: "error", message });
    socket.close(1011, "Gemini connection failed");
  }
});

server.listen(port, "127.0.0.1", async () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Voice Layer Lab is ready at ${url}`);
  console.log(`Diagnostics are written to ${logFile}`);
  if (process.env.VOICE_UI_OPEN !== "0") await open(url);
});

async function shutdown(): Promise<void> {
  for (const socket of sockets.clients) socket.close();
  sockets.close();
  server.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
