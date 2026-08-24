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

  const snapshot = state.getTranscript();
  assert.equal(snapshot.turns.length, 3);
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
