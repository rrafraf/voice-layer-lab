# Gemini TTS vs Gemini Live

Keep these as two separate paths. They are not interchangeable, and the lab UI
exposes them side by side so they can be tested independently.

## Gemini Live

- Low-latency interactive agent.
- Continuous microphone audio, optional JPEG screen/camera frames, barge-in.
- Native audio in and out. No separate STT then TTS cascade.
- Use **Start listening** in the Live panel.

## Gemini TTS

- Request/response recitation of explicit text.
- Fine-grained control: prebuilt voice plus a natural-language style prompt
  (`calm British narrator`, `[whispers]`, slower, brighter, etc.).
- Default behavior is exact recitation: no extra commentary.
- Does not see the microphone, screen, or chat box unless you paste text in.
- Use the **Gemini TTS** panel, extension sidebar, `POST /api/narrate`,
  `voice_narrate_text`, or `npm run read-clipboard`.

## Why they stay separate

Live is for conversation and turn-taking. TTS is for speaking a known script
with a chosen voice and style. Mixing them into one control would hide which
API produced the audio.

## Sources

- TTS generateContent guide: https://ai.google.dev/gemini-api/docs/generate-content/speech-generation
- TTS model card: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-tts-preview
- Live API overview: https://ai.google.dev/gemini-api/docs/live-api
