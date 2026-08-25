import assert from "node:assert/strict";
import test from "node:test";
import { VoiceLab, formatEvent } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { narrateText } from "../src/narration.js";
import { buildTtsContents, guardNarrationText, hardMaxNarrationChars, normalizeNarrationText } from "../src/core/tts.js";
import type {
  AudioSource,
  TtsProvider,
  TtsRequest,
  VoiceEventHandler,
  VoiceProvider,
} from "../src/core/types.js";
import { VoiceSessionState } from "../src/voice-session-state.js";
import { maxVideoFrameBytes, parseRealtimeVideoMessage } from "../src/core/video.js";
import {
  buildLiveSystemInstruction,
  defaultLiveVoice,
  parseLiveClientMessage,
} from "../src/core/live.js";
import { applyMotionTint, isBlankRgba, lumaStats } from "../src/core/screen-pack.js";
import { formatVisionMapTable, parseVisionMap } from "../src/core/vision-map.js";

class FakeAudio implements AudioSource {
  stopped = false;
  async start(onAudio: (chunk: Buffer) => void): Promise<void> {
    onAudio(Buffer.from([1, 2, 3]));
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
}

class FakeProvider implements VoiceProvider {
  readonly name = "fake";
  chunks: Buffer[] = [];
  frames: Buffer[] = [];
  prompts: string[] = [];
  closed = false;
  async connect(onEvent: VoiceEventHandler): Promise<void> {
    onEvent({ type: "connected", provider: this.name });
  }
  sendAudio(chunk: Buffer): void {
    this.chunks.push(chunk);
  }
  sendVideo(chunk: Buffer): void {
    this.frames.push(chunk);
  }
  sendText(text: string): void {
    this.prompts.push(text);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

test("VoiceLab keeps audio capture independent from the provider", async () => {
  const audio = new FakeAudio();
  const provider = new FakeProvider();
  const messages: string[] = [];
  const lab = new VoiceLab(audio, provider, (event) => {
    const line = formatEvent(event);
    if (line) messages.push(line);
  });

  await lab.start();
  assert.equal(provider.chunks.length, 1);
  assert.deepEqual(provider.chunks[0], Buffer.from([1, 2, 3]));
  assert.match(messages[0], /Connected to fake/);

  await lab.stop();
  assert.equal(audio.stopped, true);
  assert.equal(provider.closed, true);
});

test("input transcript events are formatted for the terminal", () => {
  assert.equal(
    formatEvent({ type: "input_transcript", text: "hello world" }),
    "You: hello world",
  );
});

test("live text prompts are formatted separately from spoken turns", () => {
  assert.equal(
    formatEvent({ type: "input_prompt", text: "Narrate the error on screen." }),
    "Prompt: Narrate the error on screen.",
  );
});

test("live client messages accept session, text, and video on one socket", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.deepEqual(
    parseLiveClientMessage(
      JSON.stringify({ type: "session", mode: "narration", style: "calm", voice: "Puck" }),
    ),
    { type: "session", mode: "narration", style: "calm", voice: "Puck", videoPack: "motion" },
  );
  assert.deepEqual(parseLiveClientMessage(JSON.stringify({ type: "text", text: "  Look at the stack.  " })), {
    type: "text",
    text: "Look at the stack.",
  });
  const video = parseLiveClientMessage(
    JSON.stringify({
      type: "video",
      mimeType: "image/jpeg",
      data: jpeg.toString("base64"),
    }),
  );
  assert.equal(video.type, "video");
  assert.deepEqual(video.type === "video" ? video.data : undefined, jpeg);
  assert.throws(() => parseLiveClientMessage(JSON.stringify({ type: "text", text: "   " })), /empty/);
  assert.throws(() => parseLiveClientMessage(JSON.stringify({ type: "phase" })), /Not a live client message/);
});

test("live system instructions wait, and do not hunt or invent", () => {
  const narration = buildLiveSystemInstruction({
    language: "en-US",
    mode: "narration",
    style: "calm present-tense",
  });
  assert.match(narration, /narrator/i);
  assert.match(narration, /do not guess/i);
  assert.match(narration, /magenta/i);
  assert.doesNotMatch(narration, /investigator/i);
  const conversation = buildLiveSystemInstruction({ language: "en-US", mode: "conversation" });
  assert.match(conversation, /wait them out/i);
  assert.match(conversation, /Do not invent/i);
  assert.match(conversation, /Text prompts/);
  const transcribe = buildLiveSystemInstruction({ language: "en-US", mode: "transcribe" });
  assert.match(transcribe, /Do not speak/);
  assert.equal(defaultLiveVoice, "Kore");
});

test("motion tint keeps static pixels and marks changed ones", () => {
  const current = Uint8ClampedArray.from([10, 20, 30, 255, 200, 10, 10, 255]);
  const previous = Uint8ClampedArray.from([10, 20, 30, 255, 10, 10, 10, 255]);
  const { pixels, movingPixels } = applyMotionTint(current, [previous]);
  assert.equal(movingPixels, 1);
  assert.equal(pixels[0], 10);
  assert.equal(pixels[1], 20);
  assert.equal(pixels[2], 30);
  assert.ok(pixels[4] > 200);
});

test("flat black pixels count as a blank frame, busy dark UI does not", () => {
  const black = new Uint8ClampedArray(32).fill(0);
  for (let index = 3; index < black.length; index += 4) black[index] = 255;
  assert.equal(isBlankRgba(black), true);
  assert.ok(lumaStats(black).mean < 1);

  const busy = Uint8ClampedArray.from([
    8, 8, 8, 255, 220, 220, 220, 255, 8, 8, 8, 255, 180, 40, 40, 255,
    12, 12, 12, 255, 40, 180, 80, 255, 200, 200, 30, 255, 16, 16, 16, 255,
  ]);
  assert.equal(isBlankRgba(busy), false);
});

test("vision maps clamp boxes and format a markdown table", () => {
  const map = parseVisionMap({
    scene: "Cursor over a browser window",
    objects: [
      { label: "Chrome", kind: "window", x: -1, y: 0.1, w: 2, h: 0.8 },
      { label: "pointer", kind: "cursor", x: 0.4, y: 0.5, w: 0.05, h: 0.05 },
    ],
  });
  assert.equal(map.objects[0]?.x, 0);
  assert.equal(map.objects[0]?.w, 1);
  assert.match(formatVisionMapTable(map), /Chrome/);
  assert.match(formatVisionMapTable(map), /cursor/);
});

test("conversation mode is accepted for the browser voice handoff", () => {
  const config = loadConfig({
    GEMINI_API_KEY: "test-key",
    VOICE_MODE: "conversation",
  });

  assert.equal(config.mode, "conversation");
});

test("server-side voice state prepares a reviewed Cursor prompt from user turns", () => {
  const state = new VoiceSessionState();

  state.handleEvent({ type: "input_transcript", text: "Add tests for the control API." });
  state.handleEvent({ type: "output_transcript", text: "Okay." });
  state.handleEvent({ type: "input_transcript", text: " Keep secrets server-side." });

  state.handleEvent({ type: "input_prompt", text: "Focus on the failing test." });

  const snapshot = state.getTranscript();
  assert.equal(snapshot.turns.length, 4);
  assert.equal(snapshot.turns.at(-1)?.speaker, "PROMPT");
  assert.match(snapshot.prompt, /Voice request for Cursor:/);
  assert.match(snapshot.prompt, /Add tests for the control API\./);
  assert.match(snapshot.prompt, /Keep secrets server-side\./);
});

test("narration input is normalized and capped before Gemini is called", () => {
  assert.equal(normalizeNarrationText(" hello\r\nworld \n"), "hello\nworld");
  assert.throws(
    () => guardNarrationText("x".repeat(hardMaxNarrationChars + 1)),
    /refusing to send/,
  );
});

test("TTS prompt keeps exact recitation and optional style", () => {
  const exact = buildTtsContents({ text: "Hello there.", exact: true });
  assert.match(exact, /exactly/i);
  assert.match(exact, /Hello there/);
  const styled = buildTtsContents({
    text: "Hello there.",
    exact: true,
    style: "calm British narrator",
  });
  assert.match(styled, /calm British narrator/);
  assert.equal(styled.includes("Hello there."), true);
});

test("narrateText talks to a TtsProvider without calling Gemini", async () => {
  const pcm = Buffer.alloc(48);
  const provider: TtsProvider = {
    name: "fake-tts",
    async synthesize(request: TtsRequest) {
      assert.equal(request.voice, "Puck");
      assert.equal(request.style, "whisper");
      return { pcm, sampleRate: 24000, model: request.model, voice: request.voice };
    },
  };

  const result = await narrateText(
    "unused-key",
    {
      text: "hello",
      voice: "Puck",
      style: "whisper",
      output: "runs/test-tts.wav",
      includeAudio: false,
    },
    provider,
  );

  assert.equal(result.api, "tts");
  assert.equal(result.voice, "Puck");
  assert.equal(result.audioBase64, undefined);
});

test("realtime video frames are JPEG and size-capped", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const parsed = parseRealtimeVideoMessage(
    JSON.stringify({
      type: "video",
      mimeType: "image/jpeg",
      data: jpeg.toString("base64"),
    }),
  );

  assert.equal(parsed.mimeType, "image/jpeg");
  assert.deepEqual(parsed.data, jpeg);
  assert.throws(() => parseRealtimeVideoMessage(JSON.stringify({ type: "phase" })), /Not a video message/);
  assert.throws(
    () =>
      parseRealtimeVideoMessage(
        JSON.stringify({
          type: "video",
          mimeType: "image/jpeg",
          data: Buffer.alloc(maxVideoFrameBytes + 1).toString("base64"),
        }),
      ),
    /max is/,
  );
});

test("voice status counts forwarded video frames", () => {
  const state = new VoiceSessionState();
  assert.equal(state.getStatus(0).videoFrames, 0);
  state.noteVideoFrame();
  state.noteVideoFrame();
  assert.equal(state.getStatus(1).videoFrames, 2);
  assert.ok(state.getStatus(1).lastVideoAt);
});
