(function () {
  const serverUrl = document.body.dataset.serverUrl.replace(/\/+$/, "");
  const startButton = document.querySelector("#start");
  const stopButton = document.querySelector("#stop");
  const refreshButton = document.querySelector("#refresh");
  const status = document.querySelector("#status");
  const transcript = document.querySelector("#transcript");
  const promptPreview = document.querySelector("#prompt-preview");
  const copyPromptButton = document.querySelector("#copy-prompt");
  const clearButton = document.querySelector("#clear");
  const narrationText = document.querySelector("#narration-text");
  const narrateButton = document.querySelector("#narrate");
  const narrationResult = document.querySelector("#narration-result");
  const videoSource = document.querySelector("#video-source");
  const videoPreview = document.querySelector("#video-preview");
  const videoState = document.querySelector("#video-state");

  let socket;
  let stream;
  let inputContext;
  let processor;
  let outputContext;
  let playbackCursor = 0;
  let activeTranscriptTurn;
  const activeSources = new Set();
  const turns = [];
  let videoStream;
  let videoTimer;
  const videoCanvas = document.createElement("canvas");
  const VIDEO_FRAME_MS = 1000;
  const VIDEO_MAX_EDGE = 1280;

  function setStatus(label, kind = "idle") {
    status.className = `status ${kind}`;
    status.innerHTML = `<span></span>${label}`;
  }

  function finishTranscriptTurn() {
    activeTranscriptTurn = undefined;
  }

  function renderPrompt(prompt) {
    promptPreview.textContent = prompt || "Your spoken Cursor prompt will appear here.";
    copyPromptButton.disabled = !prompt;
  }

  function formatCursorPrompt() {
    const spokenText = turns
      .filter((turn) => turn.speaker === "YOU")
      .map((turn) => turn.text.trim())
      .filter(Boolean)
      .join("\n\n");

    if (!spokenText) return "";
    return [
      "Voice request for Cursor:",
      "",
      spokenText,
      "",
      "Treat this as a spoken request. Resolve obvious transcription errors from context, ask before destructive changes, and keep changes scoped.",
    ].join("\n");
  }

  function appendTurn(speaker, text) {
    transcript.querySelector(".empty")?.remove();
    if (activeTranscriptTurn?.speaker === speaker) {
      activeTranscriptTurn.body.textContent += text;
      turns[activeTranscriptTurn.turnIndex].text += text;
      renderPrompt(formatCursorPrompt());
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
    renderPrompt(formatCursorPrompt());
  }

  async function api(path, options) {
    const response = await fetch(`${serverUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function downsampleTo16k(input, sourceRate) {
    if (sourceRate === 16000) return input;
    const ratio = sourceRate / 16000;
    const output = new Float32Array(Math.floor(input.length / ratio));
    for (let outIndex = 0; outIndex < output.length; outIndex++) {
      const start = Math.floor(outIndex * ratio);
      const end = Math.min(Math.floor((outIndex + 1) * ratio), input.length);
      let sum = 0;
      for (let index = start; index < end; index += 1) sum += input[index];
      output[outIndex] = sum / Math.max(1, end - start);
    }
    return output;
  }

  function floatToPcm16(input) {
    const pcm = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      const value = Math.max(-1, Math.min(1, input[index]));
      pcm[index] = value < 0 ? value * 32768 : value * 32767;
    }
    return pcm.buffer;
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
    videoState.textContent = videoSource.value === "none" ? "Audio only. JPEG frames are sent at 1 FPS." : "Video stopped";
  }

  function sendVideoFrame() {
    if (!socket || socket.readyState !== WebSocket.OPEN || !videoPreview.videoWidth) return;
    const scale = Math.min(1, VIDEO_MAX_EDGE / Math.max(videoPreview.videoWidth, videoPreview.videoHeight));
    videoCanvas.width = Math.max(1, Math.round(videoPreview.videoWidth * scale));
    videoCanvas.height = Math.max(1, Math.round(videoPreview.videoHeight * scale));
    const context = videoCanvas.getContext("2d");
    if (!context) return;
    context.drawImage(videoPreview, 0, 0, videoCanvas.width, videoCanvas.height);
    const data = videoCanvas.toDataURL("image/jpeg", 0.7).split(",")[1];
    if (data) socket.send(JSON.stringify({ type: "video", mimeType: "image/jpeg", data }));
  }

  async function startVideo() {
    stopVideo();
    const kind = videoSource.value;
    if (kind === "none") return;
    videoStream = kind === "screen"
      ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      : await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    const track = videoStream.getVideoTracks()[0];
    track?.addEventListener("ended", () => {
      videoSource.value = "none";
      stopVideo();
    });
    videoPreview.srcObject = videoStream;
    videoPreview.classList.add("active");
    videoState.textContent = `${kind} · JPEG 1 FPS`;
    videoTimer = setInterval(sendVideoFrame, VIDEO_FRAME_MS);
  }

  function playPcm16(arrayBuffer) {
    outputContext ??= new AudioContext({ sampleRate: 24000 });
    const bytes = new Int16Array(arrayBuffer);
    const audioBuffer = outputContext.createBuffer(1, bytes.length, 24000);
    const channel = audioBuffer.getChannelData(0);
    for (let index = 0; index < bytes.length; index += 1) channel[index] = bytes[index] / 32768;

    const source = outputContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(outputContext.destination);
    playbackCursor = Math.max(playbackCursor, outputContext.currentTime + 0.04);
    source.start(playbackCursor);
    playbackCursor += audioBuffer.duration;
    activeSources.add(source);
    source.onended = () => activeSources.delete(source);
  }

  function stopPlayback() {
    for (const source of activeSources) {
      try {
        source.stop();
      } catch {}
    }
    activeSources.clear();
    playbackCursor = outputContext?.currentTime ?? 0;
  }

  async function refresh() {
    const [statusPayload, transcriptPayload] = await Promise.all([
      api("/api/status"),
      api("/api/transcript"),
    ]);

    if (statusPayload.providerConnected) setStatus("Listening", "live");
    else if (statusPayload.lastError) setStatus(statusPayload.lastError, "error");
    else setStatus(statusPayload.activeClients ? "Connected" : "Idle");

    turns.length = 0;
    turns.push(...transcriptPayload.turns);
    transcript.replaceChildren();
    if (turns.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Transcript turns will appear here.";
      transcript.append(empty);
    } else {
      for (const turn of turns) {
        const row = document.createElement("div");
        row.className = `turn ${turn.speaker === "Gemini" ? "model" : "user"}`;
        const label = document.createElement("div");
        label.className = "speaker";
        label.textContent = turn.speaker;
        const body = document.createElement("p");
        body.textContent = turn.text;
        row.append(label, body);
        transcript.append(row);
      }
    }
    renderPrompt(transcriptPayload.prompt);
  }

  async function start() {
    if (socket || stream) return;
    startButton.disabled = true;
    setStatus("Connecting...");

    try {
      outputContext = new AudioContext({ sampleRate: 24000 });
      await outputContext.resume();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      inputContext = new AudioContext();
      await inputContext.resume();
      const source = inputContext.createMediaStreamSource(stream);
      processor = inputContext.createScriptProcessor(2048, 1, 1);
      const silent = inputContext.createGain();
      silent.gain.value = 0;
      source.connect(processor);
      processor.connect(silent);
      silent.connect(inputContext.destination);

      try {
        await startVideo();
      } catch (error) {
        videoState.textContent = error.message || String(error);
      }

      socket = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/voice`);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
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
          stopButton.disabled = false;
        } else if (message.type === "phase") {
          setStatus(message.message, message.level === "ok" ? "idle" : message.level);
        } else if (message.type === "input_transcript") {
          appendTurn("YOU", message.text);
        } else if (message.type === "output_transcript") {
          appendTurn("Gemini", message.text);
        } else if (message.type === "turn_complete") {
          finishTranscriptTurn();
        } else if (message.type === "interrupted") {
          finishTranscriptTurn();
          stopPlayback();
        } else if (message.type === "control" && message.action === "stop") {
          void stop();
        } else if (message.type === "error") {
          setStatus(message.message, "error");
        }
      };
      socket.onerror = () => setStatus("Local voice connection failed", "error");
      socket.onclose = () => void stop(false);
    } catch (error) {
      setStatus(error.message || String(error), "error");
      await stop(false);
    }
  }

  async function stop(resetStatus = true) {
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

  startButton.addEventListener("click", () => void start());
  stopButton.addEventListener("click", () => void stop());
  videoSource.addEventListener("change", () => {
    if (socket?.readyState === WebSocket.OPEN) {
      void startVideo().catch((error) => {
        videoState.textContent = error.message || String(error);
      });
    }
  });
  refreshButton.addEventListener("click", () => void refresh());
  copyPromptButton.addEventListener("click", async () => {
    const prompt = promptPreview.textContent;
    if (prompt && !prompt.startsWith("Your spoken")) await navigator.clipboard.writeText(prompt);
  });
  clearButton.addEventListener("click", async () => {
    await api("/api/transcript/clear", { method: "POST", body: "{}" });
    await refresh();
  });
  narrateButton.addEventListener("click", async () => {
    narrateButton.disabled = true;
    narrationResult.textContent = "Generating narration...";
    try {
      const result = await api("/api/narrate", {
        method: "POST",
        body: JSON.stringify({ text: narrationText.value }),
      });
      narrationResult.textContent = `Wrote ${result.output} (${result.characters} chars).`;
    } catch (error) {
      narrationResult.textContent = error.message || String(error);
    } finally {
      narrateButton.disabled = false;
    }
  });

  window.addEventListener("message", (event) => {
    if (event.data?.type === "start") void start();
    if (event.data?.type === "stop") void stop();
  });
  window.addEventListener("beforeunload", () => void stop(false));
  void refresh().catch((error) => setStatus(error.message || String(error), "error"));
})();
