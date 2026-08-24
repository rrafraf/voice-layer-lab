# Voice Layer Lab

A small, provider-neutral realtime voice experiment. The first adapter streams the
Windows microphone to Gemini Live, plays Gemini audio in the browser, and keeps a
reviewable prompt handoff for Cursor.

This milestone intentionally has **no automatic computer-control tools**. It lets
us measure capture quality, latency, transcript accuracy, turn detection, and cost
while making the Cursor handoff explicit: speak, review the generated prompt,
copy it, then paste it into Cursor yourself.

## Architecture

```text
Windows microphone -> FFmpeg PCM stream -> VoiceProvider -> transcript events
                                              |
                                              +-- Gemini Live (implemented)
                                              +-- OpenAI Realtime (next)
                                              +-- local model (next)
```

## Requirements

- Windows
- Node.js 20 or newer
- FFmpeg available on `PATH`
- A Gemini API key

## Setup

1. Copy `.env.example` to `.env.local`.
2. Add `GEMINI_API_KEY` to `.env.local`.
3. Run `npm install`.
4. Run `npm install` in `extension/` if you want the Cursor extension UI.
5. Run `npm run ui` to start the local voice server.
6. Speak from the browser page or Cursor extension. Review generated prompts before pasting them into Cursor.

## One-click duplex UI

Double-click `start-voice-lab.cmd`. The local page opens automatically. Select
**Start listening**, allow microphone access, and talk naturally. Gemini's audio
plays through the browser and both sides appear in the transcript panel.

The **Cursor handoff** panel collects only your spoken turns into a reviewable
prompt. Select **Copy Cursor prompt** when you want to paste the request into
Cursor. This is the current safety boundary: voice can draft intent, but Cursor
does not execute anything until you review and submit it.

The UI includes **Mute Gemini**, browser echo cancellation, noise suppression,
and automatic gain control. The API key remains in the local Node process and
is never sent to the browser. Transcripts stay in memory unless **Download
transcript** is selected.

The default input is the repaired Realtek microphone. Override
`VOICE_INPUT_DEVICE` if the Windows device name changes.

## Local control API

The browser UI, Cursor extension, and MCP server all talk to the same local
server at `http://127.0.0.1:4317` by default. `GEMINI_API_KEY` stays in the Node
process and is never sent to a webview or MCP client.

Available endpoints:

- `GET /api/status` returns server/client status and the latest error.
- `GET /api/transcript` returns in-memory transcript turns plus the reviewed Cursor prompt.
- `GET /api/prompt` returns only the reviewed prompt.
- `POST /api/transcript/clear` clears in-memory transcript turns.
- `POST /api/control/start` and `POST /api/control/stop` broadcast start/stop intent to connected voice clients.
- `POST /api/narrate` accepts explicit `{ "text": "..." }`, applies the strict speak-exactly instruction server-side, and writes a WAV under `runs/`.

Start/stop control cannot capture hidden Cursor UI state. A connected browser or
extension webview still owns microphone permission and audio capture.

## Cursor extension

The extension package lives in `extension/` and contributes:

- Activity Bar container and `Voice Lab` sidebar webview.
- Commands: `Voice Lab: Start`, `Voice Lab: Stop`, `Voice Lab: Open Panel`, `Voice Lab: Copy Reviewed Prompt`, and `Voice Lab: Narrate Selection`.
- A status bar entry that polls the local server.
- Editor context menu narration for explicit selected text.

Launch flow:

1. Start the local server with `npm run ui`.
2. Build the extension with `npm run extension:build`.
3. In Cursor, use the `Run Voice Layer Extension` launch configuration from `.vscode/launch.json`.
4. Open the Voice Lab Activity Bar view, select **Start listening**, and allow microphone access.

The extension setting `voiceLayerLab.serverUrl` can point at another local
server URL. Do not put Gemini keys in extension settings.

When running inside Cursor builds that expose the Cursor extension API, the
extension registers the local MCP server with `vscode.cursor.mcp.registerServer`.
If that API is unavailable, use the manual MCP setup below.

## MCP tools

Run the MCP stdio server with:

```powershell
npm run mcp
```

Configure Cursor MCP to launch that command from this project root. The MCP
server exposes:

- `voice_status`
- `voice_get_transcript`
- `voice_prepare_cursor_prompt`
- `voice_narrate_text`

The MCP layer calls the local control API. It can inspect the latest in-memory
voice state and narrate explicit text, but it does not read hidden editor or chat
state and does not receive the Gemini API key.

See `docs/cursor-extension-surface.md` for the current extension/MCP surfaces
checked against Cursor and Gemini documentation.

## One-shot clipboard read-aloud

Copy a short Cursor selection, then run:

```powershell
npm run read-clipboard -- --yes
```

This reads the Windows clipboard once, prints the model, voice, character count,
and rough input-token estimate, makes one Gemini API request, writes
`runs/clipboard-read-aloud.wav`, and opens the WAV. It does not start a listener,
watch the clipboard, or send anything automatically after that one request.

Guardrails:

- The script refuses more than 2000 characters per request. You can lower the cap
  with `--max-chars`, but not raise it above 2000.
- `--yes` is required before any API call. Use `--dry-run` to preview the estimate
  without calling Gemini.
- The default model is `gemini-2.5-flash-preview-tts` with the `Kore` prebuilt
  voice. Override with `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE`, `--model`, or
  `--voice`.
- Use `--sample --yes` for a harmless smoke test, `--text "..." --yes` to avoid
  clipboard access, and `--no-open` if you only want the WAV file.

## Validation

```powershell
npm run build
npm test
npm run extension:build
npm run check
npm run gate
```

The unit tests use fake audio/provider objects and pure helper functions, so
they never contact Gemini or record the microphone. Manual validation still
requires starting `npm run ui`, launching the extension host, granting microphone
permission in the Voice Lab webview, and checking MCP discovery from Cursor.

`npm run gate` is the local pre-push gate. It verifies ignore rules for secrets
and generated runtime files, checks that secret-looking files are not tracked
when the folder is a git repo, and runs the full project check.

## Next experiments

- Timestamp transcript deltas and measure end-of-turn latency.
- Save opt-in test phrases plus expected transcripts and calculate word error rate.
- Add Cursor-side helpers for inserting the reviewed prompt into the active chat.
- Add OpenAI Realtime and local transcription adapters behind `VoiceProvider`.
- Only after accuracy testing, introduce narrowly scoped, confirm-before-execute tools.
