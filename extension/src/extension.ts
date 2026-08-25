import * as path from "node:path";
import * as vscode from "vscode";

interface VoiceStatus {
  desiredListening: boolean;
  activeClients: number;
  providerConnected: boolean;
  latestSession?: string;
  lastEventAt?: string;
  lastError?: string;
}

interface PromptResponse {
  prompt: string;
}

interface NarrationResponse {
  output: string;
  bytes: number;
  characters: number;
  estimatedInputTokens: number;
  model: string;
  voice: string;
}

function getServerUrl(): string {
  return vscode.workspace
    .getConfiguration("voiceLayerLab")
    .get<string>("serverUrl", "http://127.0.0.1:4317")
    .replace(/\/+$/, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function registerCursorMcpServer(context: vscode.ExtensionContext): void {
  type CursorApi = {
    cursor?: {
      mcp?: {
        registerServer?: (config: unknown) => void;
      };
    };
  };

  const registerServer = (vscode as unknown as CursorApi).cursor?.mcp?.registerServer;
  if (!registerServer) return;

  const projectRoot = path.resolve(context.extensionPath, "..");
  registerServer({
    name: "voice-layer-lab",
    server: {
      command: process.execPath,
      args: [path.join(projectRoot, "dist", "src", "mcp", "server.js")],
      env: {
        VOICE_LAB_SERVER_URL: getServerUrl(),
      },
    },
  });
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getServerUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Voice server returned HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

class VoiceLabWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.configureWebview(view.webview);
  }

  configureWebview(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webview.html = this.renderHtml(webview);
  }

  post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  renderHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "sidebar.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "sidebar.css"));
    const serverUrl = escapeHtml(getServerUrl());

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src http://127.0.0.1:* ws://127.0.0.1:*; media-src blob: mediastream:;">
    <link rel="stylesheet" href="${styleUri}">
    <title>Voice Layer Lab</title>
  </head>
  <body data-server-url="${serverUrl}">
    <header>
      <p class="eyebrow">Local Gemini runtime</p>
      <h1>Voice Lab</h1>
      <p class="lede">Talk live, or recite exact text. Two separate paths.</p>
      <div id="status" class="status idle"><span></span>Idle</div>
    </header>

    <section class="panel live">
      <div class="section-heading">
        <div>
          <p class="eyebrow live">Gemini Live</p>
          <h2>Conversation</h2>
        </div>
      </div>
      <div class="controls">
        <button id="start" class="primary">Start listening</button>
        <button id="stop" disabled>Stop</button>
        <button id="refresh">Refresh</button>
      </div>
      <label class="field">Video source
        <select id="video-source">
          <option value="none">Audio only</option>
          <option value="camera">Camera</option>
          <option value="screen">Screen</option>
        </select>
      </label>
      <p id="video-state" class="muted">Audio only. JPEG frames are sent at 1 FPS.</p>
      <video id="video-preview" autoplay playsinline muted></video>
      <section id="transcript" class="transcript" aria-live="polite">
        <div class="empty">Start listening to see the conversation.</div>
      </section>
    </section>

    <section class="panel prompt">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Cursor handoff</p>
          <h2>Reviewed prompt</h2>
        </div>
        <button id="copy-prompt">Copy</button>
      </div>
      <pre id="prompt-preview">Your spoken Cursor prompt will appear here.</pre>
      <button id="clear">Clear transcript</button>
    </section>

    <section class="panel narration">
      <div class="section-heading">
        <div>
          <p class="eyebrow tts">Gemini TTS</p>
          <h2>Exact recitation</h2>
        </div>
      </div>
      <p class="muted">Separate from Live. Request/response recitation with voice and style prompts.</p>
      <label class="field">Model<select id="tts-model"></select></label>
      <label class="field">Voice<select id="tts-voice"></select></label>
      <label class="field">Style prompt
        <input id="tts-style" type="text" placeholder="calm British narrator">
      </label>
      <label class="exact"><input id="tts-exact" type="checkbox" checked> Recite exactly</label>
      <label class="field">Text to speak
        <textarea id="narration-text" rows="5" placeholder="Type text to narrate explicitly."></textarea>
      </label>
      <button id="narrate" class="primary tts">Speak with TTS</button>
      <audio id="tts-audio" controls></audio>
      <p id="narration-result" class="muted"></p>
    </section>

    <footer>Nothing is sent to Cursor automatically. Gemini keys stay in the local Node server.</footer>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new VoiceLabWebviewProvider(context);
  registerCursorMcpServer(context);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "voiceLayerLab.start";
  statusBar.text = "$(mic) Voice Lab";
  statusBar.tooltip = "Start Voice Layer Lab";
  statusBar.show();

  async function refreshStatus(): Promise<void> {
    try {
      const status = await requestJson<VoiceStatus>("/api/status");
      const live = status.providerConnected || status.activeClients > 0;
      statusBar.text = live ? "$(unmute) Voice Lab" : "$(mic) Voice Lab";
      statusBar.tooltip = live
        ? `Voice Lab: ${status.activeClients} client(s), provider ${status.providerConnected ? "connected" : "idle"}`
        : "Voice Lab: idle";
    } catch {
      statusBar.text = "$(mic) Voice Lab";
      statusBar.tooltip = `Voice Lab server not reachable at ${getServerUrl()}`;
    }
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("voiceLayerLab.sidebar", provider),
    statusBar,
    vscode.commands.registerCommand("voiceLayerLab.start", async () => {
      provider.post({ type: "start" });
      await requestJson<VoiceStatus>("/api/control/start", { method: "POST", body: "{}" });
      await refreshStatus();
    }),
    vscode.commands.registerCommand("voiceLayerLab.stop", async () => {
      provider.post({ type: "stop" });
      await requestJson<VoiceStatus>("/api/control/stop", { method: "POST", body: "{}" });
      await refreshStatus();
    }),
    vscode.commands.registerCommand("voiceLayerLab.openPanel", () => {
      const panel = vscode.window.createWebviewPanel(
        "voiceLayerLab.panel",
        "Voice Layer Lab",
        vscode.ViewColumn.Beside,
        { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] },
      );
      provider.configureWebview(panel.webview);
    }),
    vscode.commands.registerCommand("voiceLayerLab.copyPrompt", async () => {
      const { prompt } = await requestJson<PromptResponse>("/api/prompt");
      if (!prompt) {
        void vscode.window.showInformationMessage("Voice Lab has no reviewed prompt yet.");
        return;
      }
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage("Voice Lab prompt copied.");
    }),
    vscode.commands.registerCommand("voiceLayerLab.narrateSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      const text = editor?.document.getText(editor.selection).trim();
      if (!text) {
        void vscode.window.showWarningMessage("Select text in the editor before running Voice Lab narration.");
        return;
      }

      const result = await requestJson<NarrationResponse>("/api/narrate", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      void vscode.env.openExternal(vscode.Uri.file(result.output));
      void vscode.window.showInformationMessage(`Narrated ${result.characters} characters to ${result.output}.`);
    }),
  );

  const timer = setInterval(() => void refreshStatus(), 5000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void refreshStatus();
}

export function deactivate(): void {}
