import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

const defaultServerUrl = "http://127.0.0.1:4317";
const serverUrl = (process.env.VOICE_LAB_SERVER_URL ?? defaultServerUrl).replace(/\/+$/, "");

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const tools: ToolDefinition[] = [
  {
    name: "voice_status",
    description: "Return the current local Voice Layer Lab status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "voice_get_transcript",
    description: "Return the latest in-memory voice transcript and reviewed Cursor prompt.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "voice_prepare_cursor_prompt",
    description: "Return only the reviewed prompt generated from spoken user turns.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "voice_narrate_text",
    description: "Speak explicit text with Gemini TTS (request/response, not Live). Hidden UI state is not read.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Explicit text to narrate." },
        output: { type: "string", description: "Optional server-side WAV output path." },
        voice: { type: "string", description: "Optional Gemini prebuilt voice name." },
        model: { type: "string", description: "Optional Gemini TTS model override." },
        style: { type: "string", description: "Optional natural-language delivery style prompt." },
        exact: { type: "boolean", description: "If true, recite the text without extra words. Default true." },
        maxChars: { type: "number", description: "Optional request cap up to 2000 characters." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

function textResult(payload: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function requestJson(pathname: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${serverUrl}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Voice server returned HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function getStringArgument(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function getNumberArgument(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

function getBooleanArgument(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

const server = new Server(
  {
    name: "voice-layer-lab",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  switch (request.params.name) {
    case "voice_status":
      return textResult(await requestJson("/api/status"));

    case "voice_get_transcript":
      return textResult(await requestJson("/api/transcript"));

    case "voice_prepare_cursor_prompt": {
      const payload = await requestJson("/api/prompt");
      return textResult(payload);
    }

    case "voice_narrate_text":
      return textResult(
        await requestJson("/api/narrate", {
          method: "POST",
          body: JSON.stringify({
            text: getStringArgument(args, "text"),
            output: getStringArgument(args, "output"),
            voice: getStringArgument(args, "voice"),
            model: getStringArgument(args, "model"),
            style: getStringArgument(args, "style"),
            exact: getBooleanArgument(args, "exact"),
            maxChars: getNumberArgument(args, "maxChars"),
            includeAudio: false,
          }),
        }),
      );

    default:
      throw new Error(`Unknown voice tool: ${request.params.name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
