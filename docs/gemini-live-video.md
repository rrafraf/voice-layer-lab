# Gemini Live audio, video, and text

Voice Layer Lab streams microphone audio, optional camera or screen JPEGs, and
typed prompts on one Live session. This follows the current Gemini Live API.

## What the API actually supports

Gemini Live accepts three realtime inputs together:

| Input | Format | How this lab sends it |
| --- | --- | --- |
| Audio | raw 16-bit PCM, 16 kHz | binary WebSocket frames |
| Video | JPEG or PNG, at most 1 FPS | `{ "type": "video", "mimeType": "image/jpeg", "data": "<base64>" }` |
| Text | UTF-8 prompt | `{ "type": "text", "text": "..." }` via `sendRealtimeInput({ text })` |

Native audio models answer with **one** output modality: `AUDIO` (raw 16-bit PCM
at 24 kHz). They do not let you set `TEXT` and `AUDIO` on the same session.

Text you see in the lab is:

- **YOU:** input audio transcription
- **PROMPT:** the typed steering prompt this client sent
- **Gemini:** output audio transcription of the spoken reply

Uncheck **Hear Gemini** to keep that transcript and mute playback. That does
not switch the API to a TEXT modality.

Video frames alone do not start a model turn. Speak or send a text prompt.

## Packed frames (motion without extra API fps)

The API still gets one JPEG per second. The browser can sample 2–3 extra
frames locally (~3 Hz), keep the current screenshot as the large readable
panel, and mark pixels that changed with a light magenta tint. Optional
bottom thumbnails are older→newer. Static UI stays sharp; motion is an
attention cue, not a replacement picture.

Gemini is instructed to hunt clues, not dump the whole screen: focused app,
then cursor/dialog/error. Magenta tint is attention. This is not a separate
object-detection model in the Live audio path.

Choose the pack in **What Gemini sees**: current frame, motion tint, or tint
plus strip. **Show what Gemini sees** opens a floating resizable panel of the
packed JPEG. **Pop out view** is a separate window you can park off a shared
display. **Map objects** is a second JSON vision call that overlays boxes and
a markdown table on that view. Live speech cannot carry that table.

For Gemini 3.1 Flash Live Preview, mid-session text must use
`sendRealtimeInput({ text })`. `sendClientContent` is only for seeding initial
history.

## Session modes

Mode, Live voice, and voice-feel style are applied when the socket connects:

- **Conversation:** answer naturally, using video when the user refers to it.
- **Narration:** describe what is visible and audible in the present tense.
- **Transcribe:** stay silent; keep the input transcript.

Change mode, voice, or style by stopping and starting again. Typed prompts can
be sent at any time during an open session.

## How this repo sends frames

1. The browser or extension webview captures camera (`getUserMedia`) or screen
   (`getDisplayMedia`).
2. A canvas encodes a JPEG about once per second, scaled to a 1280px max edge.
3. The local WebSocket sends `{ "type": "video", "mimeType": "image/jpeg", "data": "<base64>" }`.
4. The Node server calls `session.sendRealtimeInput({ video: { data, mimeType: "image/jpeg" } })`.
5. Audio continues as binary PCM on the same socket.
6. Typed prompts use `session.sendRealtimeInput({ text })`.

`GET /api/live` describes this I/O contract for the UI.

## Sources

- Live API overview: https://ai.google.dev/gemini-api/docs/live-api
- Live API SDK getting started: https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk
- Live API capabilities (text, video, native-audio modality): https://ai.google.dev/gemini-api/docs/live-api/capabilities
