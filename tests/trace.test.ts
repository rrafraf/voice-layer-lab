import assert from "node:assert/strict";
import test from "node:test";
import { formatTraceLine, ingestUiTraces, matchesTraceSrc, normalizeLevel, writeTrace } from "../src/trace.js";

test("normalizeLevel maps ok to info and keeps unknown at fallback", () => {
  assert.equal(normalizeLevel("TRACE"), "trace");
  assert.equal(normalizeLevel("ok"), "info");
  assert.equal(normalizeLevel("nope", "warn"), "warn");
});

test("formatTraceLine is a short local-log row", () => {
  const line = formatTraceLine({
    seq: 1,
    at: "2026-08-24T11:32:01.248Z",
    lvl: "error",
    src: "ui.start",
    msg: "Startup failed",
    data: "NotAllowedError",
    origin: "ui",
  });
  assert.match(line, /11:32:01\.248/);
  assert.match(line, /\bERR\b/);
  assert.match(line, /ui\.start/);
  assert.match(line, /Startup failed/);
  assert.match(line, /NotAllowedError/);
  assert.equal(line.includes("\n"), false);
});

test("matchesTraceSrc pins a control to its family of lines", () => {
  assert.equal(matchesTraceSrc("ui.mute", ""), true);
  assert.equal(matchesTraceSrc("ui.mute", "ui.mute"), true);
  assert.equal(matchesTraceSrc("ui.mute.on", "ui.mute"), true);
  assert.equal(matchesTraceSrc("ui.video", "ui.mute"), false);
  assert.equal(matchesTraceSrc("ui", "ui.mute"), false);
});

test("ingestUiTraces accepts browser batches", () => {
  const before = writeTrace({ level: "debug", src: "test", msg: "marker" }).seq;
  const count = ingestUiTraces([
    { lvl: "warn", src: "ui.ws", msg: "sock.fail", data: "code=1006" },
    { ignored: true },
  ]);
  assert.equal(count, 1);
  assert.ok(before >= 1);
});
