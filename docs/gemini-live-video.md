# Gemini Live Video Input

Voice Layer Lab streams optional camera or screen frames beside microphone
audio. This follows the current Gemini Live API, not a custom video codec.

## Native audio + video

- Conversation audio uses `responseModalities: ["AUDIO"]` on a Live session.
- Microphone audio is raw 16-bit PCM at 16 kHz.
- Model audio returns as raw 16-bit PCM at 24 kHz.
- Video is not a compressed video stream. The API takes still images, typically
  JPEG, at most 1 frame per second.

## How this repo sends frames

1. The browser or extension webview captures camera (`getUserMedia`) or screen
   (`getDisplayMedia`).
2. A canvas encodes a JPEG about once per second, scaled to a 1280px max edge.
3. The local WebSocket sends `{ "type": "video", "mimeType": "image/jpeg", "data": "<base64>" }`.
4. The Node server calls `session.sendRealtimeInput({ video: { data, mimeType: "image/jpeg" } })`.
5. Audio continues as binary PCM on the same socket.

Video frames alone do not start a model turn. The user still needs to speak, or
send text, for Gemini to respond.

## Sources

- Live API overview: https://ai.google.dev/gemini-api/docs/live-api
- Live API SDK getting started: https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk
- Live API capabilities, sending video: https://ai.google.dev/gemini-api/docs/live-api/capabilities
