# Gemini TTS vs Gemini Live

Keep these as two separate paths. They are not interchangeable, and the lab UI
exposes them side by side so they can be tested independently.

## Gemini Live

- Low-latency interactive agent.
- One session can take microphone audio, JPEG screen/camera frames, and typed
  prompts together.
- Native audio in and out. No separate STT then TTS cascade.
- Output is always spoken audio on native Live models. Readable text is the
  output-audio transcript, not a second TEXT response.
- Voice and delivery style are session-level (`speechConfig` plus the system
  instruction). Typed prompts steer attention mid-session.
- Use **Start listening** plus the Live steer panel.

Useful combinations on Live:

- Speech to speech (mic in, audio out)
- Speech to text (mic in, mute playback, read the transcript)
- Video to speech / video to text (JPEG in, speak or send a prompt, hear or mute)
- Text to speech inside Live (typed prompt in, spoken reply out)

## Gemini TTS

- Request/response recitation of explicit text you already typed.
- Fine-grained control: prebuilt voice plus a natural-language style prompt
  (`calm British narrator`, `[whispers]`, slower, brighter, etc.).
- Default behavior is exact recitation: no extra commentary.
- Input is text. Output is audio only (`responseModalities: AUDIO`). There is
  no TTS text-out, and there should not be: that would duplicate the text you
  already entered.
- Does not see the microphone, screen, or Live prompt box unless you paste
  text in.
- Use the **Gemini TTS** panel, extension sidebar, `POST /api/narrate`,
  `voice_narrate_text`, or `npm run read-clipboard`.

## Why they stay separate

Live is for conversation, vision, and turn-taking. TTS is for speaking a known
script with a chosen voice and style. Mixing them into one control would hide
which API produced the audio.

## Sources

- TTS generateContent guide: https://ai.google.dev/gemini-api/docs/speech-generation
- TTS model card: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-tts-preview
- Live API overview: https://ai.google.dev/gemini-api/docs/live-api
- Live API capabilities: https://ai.google.dev/gemini-api/docs/live-api/capabilities
