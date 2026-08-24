const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const muteButton = document.querySelector("#mute");
const downloadButton = document.querySelector("#download");
const transcript = document.querySelector("#transcript");
const status = document.querySelector("#status");
const eventLog = document.querySelector("#event-log");
const copyLogButton = document.querySelector("#copy-log");
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

let socket;
let stream;
let inputContext;
let processor;
let outputContext;
let playbackCursor = 0;
let muted = false;
const activeSources = new Set();
const turns = [];
const diagnosticEvents = [];
let micTest;
const recordingUrls = { raw: undefined, processed: undefined };
let ttsAudioUrl;
let activeTranscriptTurn;
let videoStream;
let videoTimer;
const videoCanvas = document.createElement("canvas");
const VIDEO_FRAME_MS = 1000;
const VIDEO_MAX_EDGE = 1280;

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

function logEvent(level, message, details) {
  const event = { at: new Date().toISOString(), level, message, details };
  diagnosticEvents.push(event);
  const row = document.createElement("li");
  row.className = level;
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date(event.at).toLocaleTimeString();
  const severity = document.createElement("span");
  severity.className = "level";
  severity.textContent = level;
  const body = document.createElement("span");
  body.className = "message";
  body.textContent = details ? `${message} — ${details}` : message;
  row.append(time, severity, body);
  eventLog.append(row);
  eventLog.scrollTop = eventLog.scrollHeight;
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

function appendTurn(speaker, text) {
  transcript.querySelector(".empty")?.remove();
  if (activeTranscriptTurn?.speaker === speaker) {
    activeTranscriptTurn.body.textContent += text;
    turns[activeTranscriptTurn.turnIndex].text += text;
    activeTranscriptTurn.row.scrollIntoView({ behavior: "smooth", block: "end" });
    updateCursorPrompt();
    return;
  }

  finishTranscriptTurn();
  turns.push({ speaker, text, at: new Date().toISOString() });
  const row = document.createElement("div");
  row.className = `turn ${speaker === "Gemini" ? "model" : "user"}`;
  const label = document.createElement("div");
  label.className = "speaker";
  label.textContent = speaker;
  const body = document.createElement("p");
  body.textContent = text;
  row.append(label, body);
  transcript.append(row);
  activeTranscriptTurn = { speaker, body, row, turnIndex: turns.length - 1 };
  row.scrollIntoView({ behavior: "smooth", block: "end" });
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

function setVideoState(label) {
  videoState.textContent = label;
}

function stopVideo() {
  if (videoTimer) {
    clearInterval(videoTimer);
    videoTimer = undefined;
  }
  videoStream?.getTracks().forEach((track) => track.stop());
  videoStream = undefined;
  videoPreview.srcObject = null;
  videoPreview.classList.remove("active");
  setVideoState(videoSource.value === "none" ? "Audio only" : "Video stopped");
}

function sendVideoFrame() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!videoPreview.videoWidth) return;
  const scale = Math.min(1, VIDEO_MAX_EDGE / Math.max(videoPreview.videoWidth, videoPreview.videoHeight));
  videoCanvas.width = Math.max(1, Math.round(videoPreview.videoWidth * scale));
  videoCanvas.height = Math.max(1, Math.round(videoPreview.videoHeight * scale));
  const context = videoCanvas.getContext("2d");
  if (!context) return;
  context.drawImage(videoPreview, 0, 0, videoCanvas.width, videoCanvas.height);
  const dataUrl = videoCanvas.toDataURL("image/jpeg", 0.7);
  const data = dataUrl.split(",")[1];
  if (!data) return;
  socket.send(JSON.stringify({ type: "video", mimeType: "image/jpeg", data }));
}

async function startVideo() {
  stopVideo();
  const kind = videoSource.value;
  if (kind === "none") {
    setVideoState("Audio only");
    return;
  }

  logEvent("info", "Requesting video capture", kind);
  videoStream = kind === "screen"
    ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    : await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
  const track = videoStream.getVideoTracks()[0];
  track?.addEventListener("ended", () => {
    logEvent("warn", "Video track ended");
    videoSource.value = "none";
    stopVideo();
  });
  videoPreview.srcObject = videoStream;
  videoPreview.classList.add("active");
  setVideoState(`${kind} · JPEG 1 FPS`);
  logEvent("ok", "Video capture started", track?.label || kind);
  videoTimer = setInterval(sendVideoFrame, VIDEO_FRAME_MS);
}

async function start() {
  if (socket || stream) return;
  startButton.disabled = true;
  setStatus("Connecting…");
  logEvent("info", "Start requested");

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
    socket.onopen = () => {
      logEvent("ok", "Local voice connection open");
      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        socket.send(floatToPcm16(downsampleTo16k(input, inputContext.sampleRate)));
      };
    };
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        playPcm16(event.data);
        return;
      }
      const message = JSON.parse(event.data);
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
    socket.onerror = () => logEvent("error", "Local voice connection failed");
    socket.onclose = (event) => {
      const detail = `code ${event.code}${event.reason ? `, ${event.reason}` : ""}`;
      logEvent(event.wasClean ? "info" : "error", "Local voice connection closed", detail);
      if (status.textContent.includes("Connecting")) setStatus("Connection failed — see diagnostics", "error");
      void stop(false);
    };
  } catch (error) {
    const message = error.message ?? String(error);
    setStatus(message, "error");
    logEvent("error", "Startup failed", message);
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
  stopVideo();
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  socket = undefined;
  await inputContext?.close();
  inputContext = undefined;
  stopPlayback();
  await outputContext?.close();
  outputContext = undefined;
  finishTranscriptTurn();
  startButton.disabled = false;
  stopButton.disabled = true;
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
  setTimeout(() => { copyPromptButton.textContent = "Copy Cursor prompt"; }, 1200);
}

function clearTranscript() {
  turns.length = 0;
  finishTranscriptTurn();
  transcript.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = "Your conversation will appear here.";
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
  ttsState.textContent = "Ready";
}

async function speakWithTts() {
  ttsSpeakButton.disabled = true;
  ttsState.textContent = "Generating…";
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
    ttsState.textContent = `${result.voice} · ${result.characters} chars`;
    logEvent("ok", "TTS audio ready", `${result.model}, ${result.voice}`);
    await ttsAudio.play().catch(() => undefined);
  } catch (error) {
    const message = error.message ?? String(error);
    ttsState.textContent = message;
    logEvent("error", "TTS failed", message);
  } finally {
    ttsSpeakButton.disabled = false;
  }
}

startButton.addEventListener("click", start);
stopButton.addEventListener("click", () => stop());
videoSource.addEventListener("change", () => {
  if (socket?.readyState === WebSocket.OPEN) {
    void startVideo().catch((error) => {
      const message = error.message ?? String(error);
      logEvent("error", "Video source change failed", message);
      setVideoState(message);
    });
  } else {
    setVideoState(videoSource.value === "none" ? "Audio only" : `${videoSource.value} selected`);
  }
});
muteButton.addEventListener("click", () => {
  muted = !muted;
  if (muted) stopPlayback();
  muteButton.classList.toggle("active", muted);
  muteButton.textContent = muted ? "Unmute Gemini" : "Mute Gemini";
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
copyLogButton.addEventListener("click", async () => {
  const text = diagnosticEvents.map((event) => `[${event.at}] ${event.level.toUpperCase()} ${event.message}${event.details ? ` — ${event.details}` : ""}`).join("\n");
  await navigator.clipboard.writeText(text);
  copyLogButton.textContent = "Copied";
  setTimeout(() => { copyLogButton.textContent = "Copy log"; }, 1200);
});
window.addEventListener("beforeunload", () => {
  micTest?.stream?.getTracks().forEach((track) => track.stop());
  for (const url of Object.values(recordingUrls)) if (url) URL.revokeObjectURL(url);
  if (ttsAudioUrl) URL.revokeObjectURL(ttsAudioUrl);
  void stop(false);
});
void loadTtsCatalog().catch((error) => {
  ttsState.textContent = error.message ?? String(error);
  logEvent("error", "TTS catalog failed", error.message ?? String(error));
});
