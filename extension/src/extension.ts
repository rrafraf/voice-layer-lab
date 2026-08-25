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
      <p class="eyebrow">LOCAL GEMINI RUNTIME</p>
      <h1>Voice Lab</h1>
      <div id="status" class="status idle"><span></span>Idle</div>
    </header>

    <section class="controls">
      <button id="start" class="primary">Start listening</button>
      <button id="stop" disabled>Stop</button>
      <button id="refresh">Refresh</button>
    </section>

    <section class="video">
      <p class="eyebrow">VIDEO</p>
      <select id="video-source">
        <option value="none">Audio only</option>
        <option value="camera">Camera</option>
        <option value="screen">Screen</option>
      </select>
      <select id="video-pack">
        <option value="current">Current frame only</option>
        <option value="motion" selected>Current + motion tint</option>
        <option value="motion-strip">Current + tint + strip</option>
      </select>
      <p id="video-state" class="muted">Audio only. Packed JPEGs are sent at 1 FPS.</p>
      <video id="video-preview" autoplay playsinline muted></video>
      <canvas id="gemini-frame-preview"></canvas>
    </section>

    <section class="live">
      <p class="eyebrow">LIVE STEER</p>
      <p class="muted">Audio, video, and text share one Live session. Answers are spoken audio; text is the transcript. TTS stays in the panel below.</p>
      <label class="muted">Mode
        <select id="live-mode">
          <option value="conversation">Conversation</option>
          <option value="narration">Narration</option>
          <option value="transcribe">Transcribe</option>
        </select>
      </label>
      <label class="muted">Live voice<select id="live-voice"></select></label>
      <input id="live-style" type="text" placeholder="Voice feel, e.g. calm present-tense">
      <label class="muted"><input id="hear-gemini" type="checkbox" checked> Hear Gemini</label>
      <textarea id="live-prompt" rows="3" placeholder="Steer what to watch or how to answer."></textarea>
      <button id="live-send" disabled>Send prompt</button>
    </section>

    <section id="transcript" class="transcript" aria-live="polite">
      <div class="empty">Transcript turns will appear here.</div>
    </section>

    <section class="prompt">
      <div class="section-heading">
        <div>
          <p class="eyebrow">CURSOR HANDOFF</p>
          <h2>Reviewed prompt</h2>
        </div>
        <button id="copy-prompt">Copy</button>
      </div>
      <pre id="prompt-preview">Your spoken Cursor prompt will appear here.</pre>
      <button id="clear">Clear transcript</button>
    </section>

    <section class="narration">
      <p class="eyebrow">GEMINI TTS</p>
      <p class="muted">Separate from Live. Request/response recitation with voice and style prompts.</p>
      <label class="muted">Model<select id="tts-model"></select></label>
      <label class="muted">Voice<select id="tts-voice"></select></label>
      <input id="tts-style" type="text" placeholder="Style prompt, e.g. calm British narrator">
      <label class="muted"><input id="tts-exact" type="checkbox" checked> Recite exactly</label>
      <textarea id="narration-text" rows="5" placeholder="Type text to narrate explicitly."></textarea>
      <button id="narrate">Speak with TTS</button>
      <audio id="tts-audio" controls></audio>
      <p id="narration-result" class="muted"></p>
    </section>

    <footer>Nothing is sent to Cursor automatically. Gemini keys stay in the local Node server.</footer>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
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
