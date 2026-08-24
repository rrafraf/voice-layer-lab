import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { AudioSource } from "../core/types.js";

export interface FfmpegMicrophoneOptions {
  device: string;
  ffmpegPath?: string;
  platform?: NodeJS.Platform;
}

export class FfmpegMicrophone implements AudioSource {
  private process?: ChildProcessByStdio<null, Readable, Readable>;

  constructor(private readonly options: FfmpegMicrophoneOptions) {}

  async start(onAudio: (chunk: Buffer) => void): Promise<void> {
    if (this.process) throw new Error("Microphone is already running");

    const platform = this.options.platform ?? process.platform;
    if (platform !== "win32") {
      throw new Error("This first microphone adapter currently supports Windows only");
    }

    const ffmpegPath = this.options.ffmpegPath ?? "ffmpeg";
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-f",
      "dshow",
      "-i",
      `audio=${this.options.device}`,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "pipe:1",
    ];

    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;

    child.stdout.on("data", onAudio);
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) process.stderr.write(`[ffmpeg] ${message}\n`);
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        this.process = undefined;
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    if (!child || child.exitCode !== null) return;

    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
