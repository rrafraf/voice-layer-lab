import { VoiceLab, formatEvent } from "./app.js";
import { FfmpegMicrophone } from "./audio/ffmpeg-microphone.js";
import { loadConfig } from "./config.js";
import { GeminiLiveProvider } from "./providers/gemini-live.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const audio = new FfmpegMicrophone({ device: config.inputDevice });
  const provider = new GeminiLiveProvider({
    apiKey: config.apiKey,
    model: config.model,
    language: config.language,
    mode: config.mode === "transcribe" ? "transcribe" : "conversation",
  });
  const lab = new VoiceLab(audio, provider, (event) => {
    const line = formatEvent(event);
    if (line) console.log(line);
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await lab.stop();
  };

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  await lab.start();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
