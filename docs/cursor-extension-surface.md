# Cursor Extension Surface Notes

These notes capture the current integration surface checked while building the
Voice Layer Lab Cursor extension.

## Verified Surfaces

- Cursor supports VS Code-style extensions for normal IDE UI surfaces: Activity
  Bar containers, sidebar views, webview panels, commands, status bar items,
  editor menus, and settings.
- Cursor exposes Cursor-specific extension APIs under `vscode.cursor`.
- `vscode.cursor.mcp.registerServer` can register an MCP server from an
  extension without requiring a hand-written `mcp.json`.
- Cursor MCP supports tools, prompts, resources, roots, elicitation, and MCP Apps
  interactive UI responses.
- Project-specific MCP config can still be added with `.cursor/mcp.json` when a
  manual or fallback setup is better.

## Current Boundary

No stable documented extension point was found for adding a custom button inside
Cursor's native Chat/Agent composer or for reading the unsent chat prompt text.
The supported substitute in this project is:

- Activity Bar `Voice Lab` view for the main voice UI.
- Optional webview panel for a larger surface.
- Status bar mic button for always-visible access.
- Command Palette and editor context menu commands.
- MCP tools for Agent-callable voice operations.

## Sources Checked

- Cursor Extension API reference: https://cursor.com/docs/extension-api
- Cursor MCP docs: https://cursor.com/docs/mcp
- Cursor MCP guide: https://cursor.com/guides/coding-agent-mcp
- Gemini Live API guide: https://ai.google.dev/gemini-api/docs/live-api
- Gemini Live API SDK guide: https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk
- Gemini Live video frames: JPEG images at most 1 FPS via `sendRealtimeInput({ video })`
- Gemini TTS guide: https://ai.google.dev/gemini-api/docs/generate-content/speech-generation
- Gemini TTS vs Live: see `docs/gemini-tts-vs-live.md`

