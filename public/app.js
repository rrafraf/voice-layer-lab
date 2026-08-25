import { composeScreenFrame, isBlankFrame, lumaStats, videoPackLabel } from "./video-pack.js";
import { logEvent, traceLog } from "./trace.js";

const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const muteButton = document.querySelector("#mute");
const downloadButton = document.querySelector("#download");
const transcript = document.querySelector("#transcript");
const status = document.querySelector("#status");
const copyPromptButton = document.querySelector("#copy-prompt");
const clearPromptButton = document.querySelector("#clear-prompt");
const promptPreview = document.querySelector("#prompt-preview");
const ttsModel = document.querySelector("#tts-model");
const ttsVoice = document.querySelector("#tts-voice");
const ttsStyle = document.querySelector("#tts-style");
const ttsExact = document.querySelector("#tts-exact");
const ttsText = document.querySelector("#tts-text");
const ttsSpeakButton = document.querySelector("#tts-speak");
const ttsAudio = document.querySelector("#tts-audio");
const ttsDownload = document.querySelector("#tts-download");
const ttsState = document.querySelector("#tts-state");
const recordRawButton = document.querySelector("#record-raw");
const recordProcessedButton = document.querySelector("#record-processed");
const stopTestButton = document.querySelector("#stop-test");
const micTestState = document.querySelector("#mic-test-state");
const micMeter = document.querySelector("#mic-meter");
const micSettings = document.querySelector("#mic-settings");
const videoSource = document.querySelector("#video-source");
const videoPreview = document.querySelector("#video-preview");
const videoState = document.querySelector("#video-state");
const videoPack = document.querySelector("#video-pack");
const showGeminiView = document.querySelector("#show-gemini-view");
const mapObjects = document.querySelector("#map-objects");
const popGeminiView = document.querySelector("#pop-gemini-view");
const geminiViewDock = document.querySelector("#gemini-view-dock");
const geminiViewCanvas = document.querySelector("#gemini-view-canvas");
const geminiViewEmpty = document.querySelector("#gemini-view-empty");
const geminiViewError = document.querySelector("#gemini-view-error");
const geminiViewStage = document.querySelector("#gemini-view-stage");
const geminiViewTable = document.querySelector("#gemini-view-table");
const geminiViewScene = document.querySelector("#gemini-view-scene");
const geminiViewClose = document.querySelector("#gemini-view-close");
const geminiViewDrag = document.querySelector("#gemini-view-drag");
const liveMode = document.querySelector("#live-mode");
const liveVoice = document.querySelector("#live-voice");
const liveStyle = document.querySelector("#live-style");
const livePrompt = document.querySelector("#live-prompt");
const liveSendButton = document.querySelector("#live-send");
const liveState = document.querySelector("#live-state");
const hearGemini = document.querySelector("#hear-gemini");
const sessionToggle = document.querySelector("#session-toggle");
const promptToggle = document.querySelector("#prompt-toggle");
const steer = document.querySelector("#steer");

let socket;
let stream;
let inputContext;
let processor;
let outputContext;
let playbackCursor = 0;
let muted = false;
let muteReason = "user";
let sessionArmed = false;
const activeSources = new Set();
const turns = [];
let micTest;
const recordingUrls = { raw: undefined, processed: undefined };
let ttsAudioUrl;
let activeTranscriptTurn;
let videoStream;
let videoTimer;
let videoSampleTimer;
const videoCanvas = document.createElement("canvas");
const frameHistory = [];
let geminiViewWindow;
let latestVisionMap;
let visionMapInFlight = false;
let lastVisionMapAt = 0;
const VISION_MAP_MS = 2500;
const VIDEO_FRAME_MS = 1000;
const VIDEO_SAMPLE_MS = 330;
const VIDEO_HISTORY = 3;
const VIDEO_MAX_EDGE = 1280;
const BLANK_STEER = "The latest video frame is blank or unreadable. Do not guess what is on the user's screen. Wait for them to speak.";
let packedFrameCount = 0;
let skipSizeLogs = 0;
let blankSteerSent = false;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function beep(context, frequency, duration = 0.13) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + duration + 0.02);
  await wait(650);
}

function encodeWav(chunks, sampleRate) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const write = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const value = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function setMicButtons(recording) {
  recordRawButton.disabled = recording;
  recordProcessedButton.disabled = recording;
  stopTestButton.disabled = !recording;
  startButton.disabled = recording;
  sessionToggle.disabled = recording;
}

async function recordMicTest(mode) {
  if (micTest) return;
  setMicButtons(true);
  micTestState.textContent = "Requesting microphone…";
  logEvent("info", `Mic test requested`, mode);
  const cleanup = mode === "processed";
  let testStream;
  let context;

  try {
    testStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: cleanup,
        noiseSuppression: cleanup,
        autoGainControl: cleanup,
      },
    });
    const track = testStream.getAudioTracks()[0];
    const settings = track.getSettings();
    micSettings.textContent = JSON.stringify({ mode, label: track.label, ...settings }, null, 2);
    logEvent("ok", "Mic test device acquired", `${mode}: ${track.label || "default"}`);

    context = new AudioContext();
    await context.resume();
    micTest = { stream: testStream, context, stopRequested: false };
    for (const [count, frequency] of [[3, 620], [2, 620], [1, 620]]) {
      micTestState.textContent = String(count);
      await beep(context, frequency);
    }
    micTestState.textContent = "GO — recording 10s";
    await beep(context, 980, 0.18);

    const source = context.createMediaStreamSource(testStream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const processor = context.createScriptProcessor(2048, 1, 1);
    const silent = context.createGain();
    silent.gain.value = 0;
    const chunks = [];
    let peak = 0;
    source.connect(analyser);
    source.connect(processor);
    processor.connect(silent).connect(context.destination);
    processor.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      let blockPeak = 0;
      for (const sample of data) blockPeak = Math.max(blockPeak, Math.abs(sample));
      peak = Math.max(peak, blockPeak);
      micMeter.style.width = `${Math.min(100, Math.sqrt(blockPeak) * 100)}%`;
    };

    const startedAt = performance.now();
    while (!micTest.stopRequested && performance.now() - startedAt < 10000) {
      const remaining = Math.max(0, 10 - Math.floor((performance.now() - startedAt) / 1000));
      micTestState.textContent = `Recording ${remaining}s`;
      await wait(100);
    }

    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    analyser.disconnect();
    const blob = encodeWav(chunks, context.sampleRate);
    if (recordingUrls[mode]) URL.revokeObjectURL(recordingUrls[mode]);
    recordingUrls[mode] = URL.createObjectURL(blob);
    const audio = document.querySelector(`#${mode}-audio`);
    const download = document.querySelector(`#${mode}-download`);
    const summary = document.querySelector(`#${mode}-summary`);
    audio.src = recordingUrls[mode];
    download.href = recordingUrls[mode];
    download.download = `mic-${mode}-${new Date().toISOString().replaceAll(":", "-")}.wav`;
    download.hidden = false;
    summary.textContent = `${(blob.size / 1024).toFixed(0)} KiB · peak ${(20 * Math.log10(Math.max(peak, 1e-6))).toFixed(1)} dBFS`;
    micTestState.textContent = "Recorded — press play";
    logEvent("ok", "Mic test captured", `${mode}, ${context.sampleRate} Hz, ${summary.textContent}`);
  } catch (error) {
    const message = error.message ?? String(error);
    micTestState.textContent = "Capture failed";
    logEvent("error", "Mic test failed", message);
  } finally {
    testStream?.getTracks().forEach((track) => track.stop());
    await context?.close();
    micTest = undefined;
    micMeter.style.width = "0%";
    setMicButtons(false);
  }
}

function setStatus(label, kind = "idle") {
  status.className = `status ${kind}`;
  status.innerHTML = `<span></span>${label}`;
}

function finishTranscriptTurn() {
  activeTranscriptTurn = undefined;
}

function getSpokenPromptText() {
  return turns
    .filter((turn) => turn.speaker === "YOU")
    .map((turn) => turn.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function formatCursorPrompt() {
  const spokenText = getSpokenPromptText();
  if (!spokenText) return "";
  return [
    "Voice request for Cursor:",
    "",
    spokenText,
    "",
    "Treat this as a spoken request. Resolve obvious transcription errors from context, ask before destructive changes, and keep changes scoped.",
  ].join("\n");
}

function updateCursorPrompt() {
  const prompt = formatCursorPrompt();
  promptPreview.textContent = prompt || "Your spoken Cursor prompt will appear here.";
  copyPromptButton.disabled = !prompt;
  clearPromptButton.disabled = turns.length === 0;
}

function scrollTranscriptToEnd() {
  transcript.scrollTop = transcript.scrollHeight;
}

function appendTurn(speaker, text) {
  transcript.querySelector(".empty")?.remove();
  if (activeTranscriptTurn?.speaker === speaker) {
    activeTranscriptTurn.body.textContent += text;
    turns[activeTranscriptTurn.turnIndex].text += text;
    scrollTranscriptToEnd();
    updateCursorPrompt();
    return;
  }

  finishTranscriptTurn();
  turns.push({ speaker, text, at: new Date().toISOString() });
  const row = document.createElement("div");
  row.className = `turn ${speaker === "Gemini" ? "model" : speaker === "PROMPT" ? "prompt" : "user"}`;
  const label = document.createElement("div");
  label.className = "speaker";
  label.textContent = speaker;
  const body = document.createElement("p");
  body.textContent = text;
  row.append(label, body);
  transcript.append(row);
  activeTranscriptTurn = { speaker, body, row, turnIndex: turns.length - 1 };
  scrollTranscriptToEnd();
  downloadButton.disabled = false;
  updateCursorPrompt();
}

function stopPlayback() {
  for (const source of activeSources) {
    try { source.stop(); } catch {}
  }
  activeSources.clear();
  playbackCursor = outputContext?.currentTime ?? 0;
}

function playPcm16(arrayBuffer) {
  if (muted) return;
  outputContext ??= new AudioContext({ sampleRate: 24000 });
  const bytes = new Int16Array(arrayBuffer);
  const audioBuffer = outputContext.createBuffer(1, bytes.length, 24000);
  const channel = audioBuffer.getChannelData(0);
  for (let index = 0; index < bytes.length; index++) channel[index] = bytes[index] / 32768;

  const source = outputContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(outputContext.destination);
  playbackCursor = Math.max(playbackCursor, outputContext.currentTime + 0.04);
  source.start(playbackCursor);
  playbackCursor += audioBuffer.duration;
  activeSources.add(source);
  source.onended = () => activeSources.delete(source);
}

function downsampleTo16k(input, sourceRate) {
  if (sourceRate === 16000) return input;
  const ratio = sourceRate / 16000;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let outIndex = 0; outIndex < output.length; outIndex++) {
    const start = Math.floor(outIndex * ratio);
    const end = Math.min(Math.floor((outIndex + 1) * ratio), input.length);
    let sum = 0;
    for (let index = start; index < end; index++) sum += input[index];
    output[outIndex] = sum / Math.max(1, end - start);
  }
  return output;
}

function floatToPcm16(input) {
  const pcm = new Int16Array(input.length);
  for (let index = 0; index < input.length; index++) {
    const value = Math.max(-1, Math.min(1, input[index]));
    pcm[index] = value < 0 ? value * 32768 : value * 32767;
  }
  return pcm.buffer;
}

function setMuted(nextMuted, reason = "user") {
  const next = Boolean(nextMuted);
  if (muted === next) {
    muteReason = reason;
    return;
  }
  muted = next;
  muteReason = reason;
  if (muted) {
    stopPlayback();
  } else if (outputContext) {
    playbackCursor = outputContext.currentTime;
    void outputContext.resume();
  }
  muteButton.classList.toggle("active", muted);
  muteButton.classList.toggle("off", muted);
  muteButton.textContent = "Out";
  muteButton.setAttribute("aria-pressed", muted ? "false" : "true");
  hearGemini.checked = !muted;
  traceLog("info", "ui.mute", muted ? "on" : "off", reason);
}

function formatUiError(error) {
  const raw = error?.message ?? String(error ?? "");
  try {
    const parsed = JSON.parse(raw);
    const nested = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  } catch {
    /* keep the raw message */
  }
  const compact = raw.replace(/\s+/g, " ").trim();
  return compact.length > 96 ? `${compact.slice(0, 93)}…` : compact;
}

function setTtsState(label, kind = "ok") {
  ttsState.textContent = label;
  ttsState.className = `test-state${kind === "error" ? " error" : ""}`;
}

function setVideoState(label) {
  videoState.textContent = label;
  videoState.hidden = label === "Audio only" || / selected$/.test(label);
}

function syncSessionToggle() {
  const running = sessionArmed || Boolean(socket || stream);
  sessionToggle.textContent = running ? "Stop" : "Start";
  sessionToggle.classList.toggle("running", running);
}

function setFace(face) {
  document.body.dataset.face = face;
  document.querySelector("#face-live").hidden = face !== "live";
  document.querySelector("#face-tts").hidden = face !== "tts";
  for (const tab of document.querySelectorAll(".mode-switch [role='tab']")) {
    tab.setAttribute("aria-selected", String(tab.dataset.face === face));
  }
}

function sendLiveSession() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: "session",
    mode: liveMode.value,
    style: liveStyle.value,
    voice: liveVoice.value,
    videoPack: videoPack.value,
  }));
    liveState.textContent = `${liveMode.value} · ${liveVoice.value}`;
    logEvent("info", "Live session config sent", `${liveMode.value}, ${liveVoice.value}, ${videoPackLabel(videoPack.value)}`);
    traceLog("debug", "ui.live", "session.send", `${liveMode.value}/${liveVoice.value} pack=${videoPack.value}`);
}

function sendLivePrompt() {
  const text = livePrompt.value.trim();
  if (!text) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    liveState.textContent = "Listen first";
    logEvent("warn", "Live prompt ignored; session is not open");
    return;
  }
  socket.send(JSON.stringify({ type: "text", text }));
  livePrompt.value = "";
  liveState.textContent = "Prompt sent";
  logEvent("ok", "Live text prompt sent", `${text.length} characters`);
}

function stopVideo() {
  if (videoTimer) {
    clearInterval(videoTimer);
    videoTimer = undefined;
  }
  if (videoSampleTimer) {
    clearInterval(videoSampleTimer);
    videoSampleTimer = undefined;
  }
  frameHistory.length = 0;
  videoStream?.getTracks().forEach((track) => track.stop());
  videoStream = undefined;
  videoPreview.srcObject = null;
  videoPreview.classList.remove("active");
  packedFrameCount = 0;
  skipSizeLogs = 0;
  blankSteerSent = false;
  setGeminiError("");
  setVideoState(videoSource.value === "none" ? "See off" : "See stopped");
  if (!geminiViewCanvas.classList.contains("has-frame")) setGeminiEmpty();
}

function geminiEmptyText() {
  if (videoSource.value === "none") return "See is off. Pick Camera or Screen, then Listen.";
  if (!videoStream) return `${videoSource.value} selected. Listen to pack frames.`;
  if (!videoPreview.videoWidth) return "Waiting for the first video frame…";
  return "Packing frames…";
}

function geminiSceneLabel(map = latestVisionMap) {
  return map?.scene || videoPackLabel(videoPack.value);
}

function setGeminiError(text) {
  if (!text) {
    geminiViewError.hidden = true;
    geminiViewError.textContent = "";
    return;
  }
  geminiViewError.hidden = false;
  geminiViewError.textContent = text;
}

function setGeminiEmpty(text = geminiEmptyText()) {
  geminiViewCanvas.classList.remove("has-frame");
  geminiViewStage.classList.remove("has-frame");
  geminiViewEmpty.textContent = text;
}

function waitForVideo(video, timeoutMs = 5000) {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Video has no frames after ${timeoutMs}ms (readyState=${video.readyState})`));
    }, timeoutMs);
    const onReady = () => {
      if (video.videoWidth > 0) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("playing", onReady);
    };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("playing", onReady);
    void video.play().catch(() => undefined);
  });
}

function capturePreviewFrame() {
  if (!videoPreview.videoWidth) {
    skipSizeLogs += 1;
    if (skipSizeLogs === 1 || skipSizeLogs % 20 === 0) {
      traceLog("trace", "ui.video", "skip.no-size", `n=${skipSizeLogs} readyState=${videoPreview.readyState}`);
    }
    return;
  }
  const scale = Math.min(1, VIDEO_MAX_EDGE / Math.max(videoPreview.videoWidth, videoPreview.videoHeight));
  videoCanvas.width = Math.max(1, Math.round(videoPreview.videoWidth * scale));
  videoCanvas.height = Math.max(1, Math.round(videoPreview.videoHeight * scale));
  const context = videoCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  context.drawImage(videoPreview, 0, 0, videoCanvas.width, videoCanvas.height);
  const frame = context.getImageData(0, 0, videoCanvas.width, videoCanvas.height);
  frameHistory.push(frame);
  if (frameHistory.length > VIDEO_HISTORY) frameHistory.shift();
}

function formatVisionTable(map) {
  if (!map) return "Enable Map objects to overlay a detection table on this packed frame. Park this panel off a shared screen.";
  const rows = (map.objects ?? []).map((object) => `| ${object.kind} | ${object.label} | ${Number(object.x).toFixed(2)} | ${Number(object.y).toFixed(2)} |`);
  return [`${map.scene || "Scene"}`, "", "| kind | label | x | y |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

function drawVisionOverlay(context, width, height, map) {
  if (!map?.objects) return;
  for (const object of map.objects) {
    const x = object.x * width;
    const y = object.y * height;
    const w = object.w * width;
    const h = object.h * height;
    context.strokeStyle = "#7db6ff";
    context.lineWidth = 2;
    context.strokeRect(x, y, w, h);
    context.fillStyle = "rgba(7, 16, 27, 0.75)";
    context.fillRect(x, Math.max(0, y - 16), Math.min(width - x, 180), 16);
    context.fillStyle = "#eef2f6";
    context.font = "11px ui-sans-serif, sans-serif";
    context.fillText(`${object.kind}: ${object.label}`, x + 4, Math.max(12, y - 4));
  }
}

function publishGeminiView(canvas, map = latestVisionMap) {
  const context = geminiViewCanvas.getContext("2d");
  if (!context || !canvas?.width) {
    setGeminiEmpty();
    return;
  }
  geminiViewCanvas.width = canvas.width;
  geminiViewCanvas.height = canvas.height;
  context.drawImage(canvas, 0, 0);
  drawVisionOverlay(context, canvas.width, canvas.height, map);
  geminiViewCanvas.classList.add("has-frame");
  geminiViewStage.classList.add("has-frame");
  geminiViewScene.textContent = geminiSceneLabel(map);
  geminiViewTable.textContent = formatVisionTable(map);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
  if (geminiViewWindow && !geminiViewWindow.closed) {
    geminiViewWindow.postMessage({ type: "gemini-view", dataUrl, map, table: formatVisionTable(map) }, location.origin);
  }
}

function setGeminiViewOpen(open) {
  geminiViewDock.hidden = !open;
  showGeminiView.checked = open;
  if (open && !geminiViewCanvas.classList.contains("has-frame")) {
    setGeminiEmpty();
    if (videoStream) packAndPreview();
  }
}

function showPackedPreview(canvas) {
  publishGeminiView(canvas);
  if (mapObjects.checked) void requestVisionMap(canvas);
}

async function requestVisionMap(canvas) {
  if (visionMapInFlight) return;
  if (Date.now() - lastVisionMapAt < VISION_MAP_MS) return;
  visionMapInFlight = true;
  lastVisionMapAt = Date.now();
  try {
    const image = canvas.toDataURL("image/jpeg", 0.55).split(",")[1];
    const response = await fetch("/api/vision-map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, mimeType: "image/jpeg" }),
    });
    const map = await response.json();
    if (!response.ok) throw new Error(map.error || `HTTP ${response.status}`);
    latestVisionMap = map;
    publishGeminiView(canvas, map);
    logEvent("ok", "Vision map", map.scene || `${map.objects?.length ?? 0} objects`);
  } catch (error) {
    logEvent("warn", "Vision map failed", error.message ?? String(error));
    setGeminiError(`Vision map failed: ${error.message ?? String(error)}`);
  } finally {
    visionMapInFlight = false;
  }
}

function packAndPreview() {
  capturePreviewFrame();
  if (!frameHistory.length) {
    if (!geminiViewCanvas.classList.contains("has-frame")) setGeminiEmpty();
    return undefined;
  }
  const packed = composeScreenFrame(frameHistory, videoPack.value, VIDEO_MAX_EDGE) ?? videoCanvas;
  packedFrameCount += 1;
  const latest = frameHistory[frameHistory.length - 1];
  const stats = lumaStats(latest.data);
  const blank = isBlankFrame(latest);
  if (packedFrameCount === 1 || packedFrameCount % 10 === 0 || blank) {
    traceLog(
      blank ? "warn" : "debug",
      "ui.video",
      blank ? "pack.blank" : "pack",
      `n=${packedFrameCount} ${packed.width}x${packed.height} luma=${stats.mean.toFixed(1)} var=${stats.variance.toFixed(1)} hist=${frameHistory.length} src=${videoPreview.videoWidth}x${videoPreview.videoHeight}`,
    );
  }
  showPackedPreview(packed);
  return { packed, blank, stats };
}

function sendVideoFrame() {
  const result = packAndPreview();
  if (!result) return;
  const { packed, blank, stats } = result;
  if (blank) {
    setGeminiError(`Packed frame looks blank (luma ${stats.mean.toFixed(0)}, var ${stats.variance.toFixed(0)}). Not sending to Gemini. The preview image is the whole field of view.`);
    if (socket?.readyState === WebSocket.OPEN && !blankSteerSent) {
      blankSteerSent = true;
      socket.send(JSON.stringify({ type: "text", text: BLANK_STEER }));
      logEvent("warn", "Blank frame — told Gemini not to guess");
    }
    return;
  }
  setGeminiError("");
  blankSteerSent = false;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const data = packed.toDataURL("image/jpeg", 0.72).split(",")[1];
  if (!data) {
    traceLog("warn", "ui.video", "jpeg.empty", `${packed.width}x${packed.height}`);
    return;
  }
  socket.send(JSON.stringify({ type: "video", mimeType: "image/jpeg", data }));
}

function startVideoSampling() {
  if (videoSampleTimer) clearInterval(videoSampleTimer);
  if (videoTimer) clearInterval(videoTimer);
  const pack = videoPack.value;
  if (pack !== "current") videoSampleTimer = setInterval(capturePreviewFrame, VIDEO_SAMPLE_MS);
  videoTimer = setInterval(sendVideoFrame, VIDEO_FRAME_MS);
}

async function startVideo() {
  stopVideo();
  const kind = videoSource.value;
  if (kind === "none") {
    setVideoState("See off");
    return;
  }

  logEvent("info", "Requesting video capture", kind);
  traceLog("info", "ui.video", "capture.request", kind);
  try {
    videoStream = kind === "screen"
      ? await startScreenCapture()
      : await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
  } catch (error) {
    const message = `${error.name || "Error"}: ${error.message ?? String(error)}`;
    traceLog("error", "ui.video", "capture.fail", message);
    throw error;
  }
  const track = videoStream.getVideoTracks()[0];
  track?.addEventListener("ended", () => {
    traceLog("warn", "ui.video", "track.ended", track?.label || kind);
    videoSource.value = "none";
    stopVideo();
  });
  videoPreview.srcObject = videoStream;
  videoPreview.classList.add("active");
  await waitForVideo(videoPreview);
  setVideoState(`${kind} · 1 FPS send · ${videoPackLabel(videoPack.value)}`);
  traceLog("info", "ui.video", "ready", `${kind} ${videoPreview.videoWidth}x${videoPreview.videoHeight} ${track?.label || ""}`);
  if (showGeminiView.checked || mapObjects.checked) setGeminiViewOpen(true);
  startVideoSampling();
  packAndPreview();
}

async function startScreenCapture() {
  const options = { video: true, audio: false };
  try {
    if (typeof CaptureController === "function") {
      const controller = new CaptureController();
      controller.setFocusBehavior?.("no-focus-change");
      options.controller = controller;
    }
  } catch {
    delete options.controller;
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia(options);
  } catch (error) {
    if (options.controller && error?.name !== "NotAllowedError" && error?.name !== "AbortError") {
      return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    }
    throw error;
  }
}

async function start() {
  if (socket || stream || sessionArmed) return;
  sessionArmed = true;
  startButton.disabled = true;
  syncSessionToggle();
  setStatus("Connecting…");
  logEvent("info", "Start requested");
  traceLog("info", "ui.start", "click");

  try {
    outputContext = new AudioContext({ sampleRate: 24000 });
    await outputContext.resume();
    logEvent("ok", "Playback audio context ready", `${outputContext.sampleRate} Hz`);
    logEvent("info", "Requesting microphone permission");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const track = stream.getAudioTracks()[0];
    logEvent("ok", "Microphone acquired", track?.label || "default device");
    track?.addEventListener("ended", () => logEvent("error", "Microphone track ended unexpectedly"));
    track?.addEventListener("mute", () => logEvent("warn", "Microphone track muted by browser or system"));
    track?.addEventListener("unmute", () => logEvent("ok", "Microphone track unmuted"));

    inputContext = new AudioContext();
    await inputContext.resume();
    const source = inputContext.createMediaStreamSource(stream);
    processor = inputContext.createScriptProcessor(2048, 1, 1);
    const silent = inputContext.createGain();
    silent.gain.value = 0;
    source.connect(processor);
    processor.connect(silent);
    silent.connect(inputContext.destination);
    logEvent("ok", "Microphone audio pipeline ready", `${inputContext.sampleRate} Hz to 16000 Hz`);
    traceLog("debug", "ui.mic", "pipeline", `src=${inputContext.sampleRate} dst=16000`);

    try {
      await startVideo();
    } catch (error) {
      const message = error.message ?? String(error);
      logEvent("error", "Video capture failed; continuing with audio", message);
      setVideoState(message);
    }

    socket = new WebSocket(`ws://${location.host}/voice`);
    socket.binaryType = "arraybuffer";
    logEvent("info", "Opening local voice connection");
    traceLog("info", "ui.ws", "connecting", `ws://${location.host}/voice`);
    let audioOutCount = 0;
    socket.onopen = () => {
      logEvent("ok", "Local voice connection open");
      traceLog("info", "ui.ws", "open");
      sendLiveSession();
      liveSendButton.disabled = false;
      let audioBlocks = 0;
      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        audioBlocks += 1;
        if (audioBlocks === 1 || audioBlocks % 25 === 0) {
          let peak = 0;
          let sum = 0;
          for (const sample of input) {
            const abs = Math.abs(sample);
            peak = Math.max(peak, abs);
            sum += sample * sample;
          }
          traceLog("trace", "ui.mic", "pcm", `n=${audioBlocks} frames=${input.length} rms=${Math.sqrt(sum / input.length).toFixed(4)} peak=${peak.toFixed(4)}`);
        }
        socket.send(floatToPcm16(downsampleTo16k(input, inputContext.sampleRate)));
      };
    };
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        audioOutCount += 1;
        if (audioOutCount === 1 || audioOutCount % 20 === 0) {
          traceLog("trace", "ui.ws", "audio.out", `n=${audioOutCount} bytes=${event.data.byteLength}`);
        }
        playPcm16(event.data);
        return;
      }
      const message = JSON.parse(event.data);
      traceLog("debug", "ui.ws", `msg.${message.type ?? "unknown"}`, message.message ?? message.action ?? "");
      if (message.type === "connected") {
        setStatus("Listening", "live");
        logEvent("ok", "Gemini Live connected; listening started");
        stopButton.disabled = false;
      } else if (message.type === "phase") {
        logEvent(message.level ?? "info", message.message);
      } else if (message.type === "status") {
        logEvent("info", "Server status", `${message.activeClients} client(s), provider ${message.providerConnected ? "connected" : "idle"}`);
      } else if (message.type === "control") {
        if (message.action === "start") void start();
        if (message.action === "stop") void stop();
      } else if (message.type === "input_transcript") {
        appendTurn("YOU", message.text);
      } else if (message.type === "input_prompt") {
        appendTurn("PROMPT", message.text);
      } else if (message.type === "output_transcript") {
        appendTurn("Gemini", message.text);
      } else if (message.type === "turn_complete") {
        finishTranscriptTurn();
      } else if (message.type === "interrupted") {
        finishTranscriptTurn();
        stopPlayback();
      } else if (message.type === "error") {
        setStatus(message.message, "error");
        logEvent("error", "Server reported an error", message.message);
      }
    };
    socket.onerror = () => {
      logEvent("error", "Local voice connection failed");
      traceLog("error", "ui.ws", "error");
    };
    socket.onclose = (event) => {
      const detail = `code ${event.code}${event.reason ? `, ${event.reason}` : ""}`;
      logEvent(event.wasClean ? "info" : "error", "Local voice connection closed", detail);
      traceLog(event.wasClean ? "info" : "error", "ui.ws", "close", detail);
      if (status.textContent.includes("Connecting")) setStatus("Connection failed — see diagnostics", "error");
      void stop(false);
    };
  } catch (error) {
    const message = error.message ?? String(error);
    setStatus(message, "error");
    logEvent("error", "Startup failed", message);
    traceLog("error", "ui.start", "fail", message);
    await stop(false);
  }
}

async function stop(resetStatus = true) {
  logEvent("info", resetStatus ? "Stop requested" : "Cleaning up session");
  if (processor) processor.onaudioprocess = null;
  processor?.disconnect();
  processor = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  if (videoSource.value === "none") stopVideo();
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  socket = undefined;
  await inputContext?.close();
  inputContext = undefined;
  stopPlayback();
  await outputContext?.close();
  outputContext = undefined;
  finishTranscriptTurn();
  sessionArmed = false;
  startButton.disabled = false;
  stopButton.disabled = true;
  liveSendButton.disabled = true;
  syncSessionToggle();
  if (resetStatus) setStatus("Idle");
}

function downloadTranscript() {
  const text = turns.map((turn) => `[${turn.at}] ${turn.speaker}: ${turn.text}`).join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `voice-transcript-${new Date().toISOString().replaceAll(":", "-")}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyCursorPrompt() {
  const prompt = formatCursorPrompt();
  if (!prompt) return;
  await navigator.clipboard.writeText(prompt);
  copyPromptButton.textContent = "Copied";
  logEvent("ok", "Cursor prompt copied", `${prompt.length} characters`);
  setTimeout(() => { copyPromptButton.textContent = "Copy"; }, 1200);
}

function clearTranscript() {
  turns.length = 0;
  finishTranscriptTurn();
  transcript.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = "No conversation yet";
  const hint = document.createElement("span");
  hint.textContent = "Listen to capture Live turns.";
  empty.append(title, hint);
  transcript.append(empty);
  downloadButton.disabled = true;
  updateCursorPrompt();
  logEvent("info", "Transcript cleared");
}

function fillSelect(select, values, selected) {
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement("option");
    if (typeof value === "string") {
      option.value = value;
      option.textContent = value;
    } else {
      option.value = value.name;
      option.textContent = `${value.name} · ${value.description}`;
    }
    if (option.value === selected) option.selected = true;
    select.append(option);
  }
}

async function loadTtsCatalog() {
  const response = await fetch("/api/tts");
  const catalog = await response.json();
  fillSelect(ttsModel, catalog.models, catalog.defaultModel);
  fillSelect(ttsVoice, catalog.voices, catalog.defaultVoice);
  setTtsState("Ready");
}

async function loadLiveCatalog() {
  const response = await fetch("/api/live");
  const catalog = await response.json();
  fillSelect(liveVoice, catalog.voices, catalog.defaultVoice);
  liveState.textContent = `${liveMode.value} · ${liveVoice.value}`;
}

async function speakWithTts() {
  ttsSpeakButton.disabled = true;
  setTtsState("Generating…");
  logEvent("info", "TTS request", ttsVoice.value);
  try {
    const response = await fetch("/api/narrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: ttsText.value,
        model: ttsModel.value,
        voice: ttsVoice.value,
        style: ttsStyle.value,
        exact: ttsExact.checked,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    if (!result.audioBase64) throw new Error("TTS returned no audio.");
    const bytes = Uint8Array.from(atob(result.audioBase64), (character) => character.charCodeAt(0));
    if (ttsAudioUrl) URL.revokeObjectURL(ttsAudioUrl);
    ttsAudioUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    ttsAudio.src = ttsAudioUrl;
    ttsDownload.href = ttsAudioUrl;
    ttsDownload.download = `tts-${result.voice}-${new Date().toISOString().replaceAll(":", "-")}.wav`;
    ttsDownload.hidden = false;
    setTtsState(`${result.voice} · ${result.characters} chars`);
    logEvent("ok", "TTS audio ready", `${result.model}, ${result.voice}`);
    await ttsAudio.play().catch(() => undefined);
  } catch (error) {
    const message = error.message ?? String(error);
    setTtsState(formatUiError(error), "error");
    logEvent("error", "TTS failed", message);
  } finally {
    ttsSpeakButton.disabled = false;
  }
}

startButton.addEventListener("click", start);
stopButton.addEventListener("click", () => stop());
sessionToggle.addEventListener("click", () => {
  if (sessionArmed || socket || stream) void stop();
  else void start();
});
for (const tab of document.querySelectorAll(".mode-switch [role='tab']")) {
  tab.addEventListener("click", () => setFace(tab.dataset.face));
}
promptToggle.addEventListener("click", () => {
  const open = steer.hidden;
  steer.hidden = !open;
  promptToggle.setAttribute("aria-pressed", String(open));
});
videoSource.addEventListener("change", () => {
  void startVideo().catch((error) => {
    const message = error.message ?? String(error);
    logEvent("error", "Video source change failed", message);
    setVideoState(message);
    setGeminiEmpty(message);
  });
});
videoPack.addEventListener("change", () => {
  if (videoStream) {
    startVideoSampling();
    setVideoState(`${videoSource.value} · 1 FPS send · ${videoPackLabel(videoPack.value)}`);
    logEvent("info", "Video pack changed", videoPackLabel(videoPack.value));
  }
  if (socket?.readyState === WebSocket.OPEN) {
    const note = videoPack.value === "current"
      ? "Video pack is now a single current frame. Read the screenshot directly."
      : "Video pack now tints changed pixels magenta on the current screenshot. Read the untinted UI; use magenta as attention for motion, cursor, and dialogs.";
    socket.send(JSON.stringify({ type: "text", text: note }));
  }
});
showGeminiView.addEventListener("change", () => setGeminiViewOpen(showGeminiView.checked));
geminiViewClose.addEventListener("click", () => setGeminiViewOpen(false));
popGeminiView.addEventListener("click", () => {
  geminiViewWindow = window.open("/gemini-view.html", "gemini-view", "width=520,height=460,resizable=yes");
  setGeminiViewOpen(true);
  logEvent("info", "Gemini view popped out");
});
mapObjects.addEventListener("change", () => {
  if (!mapObjects.checked) {
    latestVisionMap = undefined;
    geminiViewTable.textContent = formatVisionTable();
    geminiViewScene.textContent = "";
  } else {
    setGeminiViewOpen(true);
    logEvent("info", "Object mapping enabled");
  }
});
geminiViewDrag.addEventListener("mousedown", (event) => {
  if (event.target.closest("button")) return;
  const rect = geminiViewDock.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  const move = (moveEvent) => {
    geminiViewDock.style.left = `${Math.max(0, moveEvent.clientX - offsetX)}px`;
    geminiViewDock.style.top = `${Math.max(0, moveEvent.clientY - offsetY)}px`;
    geminiViewDock.style.right = "auto";
    geminiViewDock.style.bottom = "auto";
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});
muteButton.addEventListener("click", () => {
  setMuted(!muted, "button");
});
hearGemini.addEventListener("change", () => {
  setMuted(!hearGemini.checked, "hear-checkbox");
});
liveSendButton.addEventListener("click", sendLivePrompt);
livePrompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendLivePrompt();
  }
});
liveMode.addEventListener("change", () => {
  if (liveMode.value === "transcribe") setMuted(true, "transcribe");
  else if (muteReason === "transcribe") setMuted(false, "mode");
  liveState.textContent = socket?.readyState === WebSocket.OPEN
    ? "Stop and start to apply a new mode"
    : `${liveMode.value} · ${liveVoice.value}`;
});
downloadButton.addEventListener("click", downloadTranscript);
copyPromptButton.addEventListener("click", () => void copyCursorPrompt());
clearPromptButton.addEventListener("click", clearTranscript);
ttsSpeakButton.addEventListener("click", () => void speakWithTts());
recordRawButton.addEventListener("click", () => recordMicTest("raw"));
recordProcessedButton.addEventListener("click", () => recordMicTest("processed"));
stopTestButton.addEventListener("click", () => {
  if (micTest) micTest.stopRequested = true;
});
window.addEventListener("beforeunload", () => {
  geminiViewWindow?.close();
  micTest?.stream?.getTracks().forEach((track) => track.stop());
  for (const url of Object.values(recordingUrls)) if (url) URL.revokeObjectURL(url);
  if (ttsAudioUrl) URL.revokeObjectURL(ttsAudioUrl);
  void stop(false);
});
void Promise.all([loadTtsCatalog(), loadLiveCatalog()]).catch((error) => {
  setTtsState(formatUiError(error), "error");
  liveState.textContent = error.message ?? String(error);
  logEvent("error", "API catalog failed", error.message ?? String(error));
});
