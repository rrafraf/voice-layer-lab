import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { config as loadEnvFile } from "dotenv";
import open from "open";
import {
  defaultTtsModel,
  defaultTtsVoice,
  estimateTokens,
  generateNarrationPcm,
  guardNarrationText,
  hardMaxNarrationChars,
  normalizeNarrationText,
  pcmToWav,
} from "./narration.js";

loadEnvFile({ path: [".env.local", ".env"], quiet: true });

const execFileAsync = promisify(execFile);
const defaultOutput = join("runs", "clipboard-read-aloud.wav");

interface CliOptions {
  yes: boolean;
  dryRun: boolean;
  noOpen: boolean;
  text?: string;
  output: string;
  model: string;
  voice: string;
  style?: string;
  maxChars: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    yes: false,
    dryRun: false,
    noOpen: false,
    output: defaultOutput,
    model: process.env.GEMINI_TTS_MODEL?.trim() || defaultTtsModel,
    voice: process.env.GEMINI_TTS_VOICE?.trim() || defaultTtsVoice,
    maxChars: hardMaxNarrationChars,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--yes") options.yes = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--sample") options.text = "This is a small one-shot Gemini read-aloud test from the clipboard path.";
    else if (arg === "--text") {
      if (!next) throw new Error("--text requires a value");
      options.text = next;
      index += 1;
    } else if (arg === "--out") {
      if (!next) throw new Error("--out requires a file path");
      options.output = next;
      index += 1;
    } else if (arg === "--model") {
      if (!next) throw new Error("--model requires a Gemini TTS model name");
      options.model = next;
      index += 1;
    }     else if (arg === "--voice") {
      if (!next) throw new Error("--voice requires a prebuilt voice name");
      options.voice = next;
      index += 1;
    } else if (arg === "--style") {
      if (!next) throw new Error("--style requires a delivery prompt");
      options.style = next;
      index += 1;
    } else if (arg === "--max-chars") {
      if (!next) throw new Error("--max-chars requires a number");
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > hardMaxNarrationChars) {
        throw new Error(`--max-chars must be an integer from 1 to ${hardMaxNarrationChars}`);
      }
      options.maxChars = parsed;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`Read copied Cursor text aloud once with Gemini TTS.

Usage:
  npm run read-clipboard -- --yes
  npm run read-clipboard -- --sample --yes
  npm run read-clipboard -- --text "Short text to read" --yes

Options:
  --yes                 Required to call the Gemini API.
  --dry-run             Print the estimate and stop before the API call.
  --sample              Use a harmless built-in sample instead of the clipboard.
  --text <text>         Use explicit text instead of the clipboard.
  --out <path>          WAV output path. Default: ${defaultOutput}
  --model <model>       Gemini TTS model. Default: ${defaultTtsModel}
  --voice <voice>       Prebuilt voice. Default: ${defaultTtsVoice}
  --style <text>        Optional natural-language delivery style prompt.
  --max-chars <number>  Request cap, maximum ${hardMaxNarrationChars}. Default: ${hardMaxNarrationChars}
  --no-open             Do not open the WAV after writing it.
`);
}

async function readClipboardText(): Promise<string> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw",
    ]);
    return stdout;
  }

  throw new Error("Clipboard reading is only implemented for Windows. Use --text or --sample on this platform.");
}

async function generateSpeech(options: CliOptions, text: string): Promise<Buffer> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing. Add it to .env.local or the process environment.");

  return generateNarrationPcm(apiKey, {
    text,
    model: options.model,
    voice: options.voice,
    style: options.style,
    exact: true,
    maxChars: options.maxChars,
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sourceText = options.text ?? (await readClipboardText());
  const text = normalizeNarrationText(sourceText);
  guardNarrationText(text, options.maxChars);

  console.log("Gemini read-aloud one-shot");
  console.log(`Model: ${options.model}`);
  console.log(`Voice: ${options.voice}`);
  if (options.style) console.log(`Style: ${options.style}`);
  console.log(`Characters: ${text.length}/${options.maxChars}`);
  console.log(`Estimated input tokens: about ${estimateTokens(text)} before instruction overhead`);
  console.log(`Output file: ${options.output}`);
  console.log("This will make exactly one Gemini API request and will not start a background listener.");

  if (options.dryRun) {
    console.log("Dry run selected; no API call made.");
    return;
  }

  if (!options.yes) {
    console.log("Refusing to call the API without --yes. Re-run with --yes after reviewing the estimate above.");
    return;
  }

  const pcm = await generateSpeech(options, text);
  const wav = pcmToWav(pcm);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, wav);
  console.log(`Wrote ${options.output} (${wav.length} bytes).`);

  if (!options.noOpen) await open(options.output, { wait: false });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Read-aloud failed: ${message}`);
  process.exitCode = 1;
});
