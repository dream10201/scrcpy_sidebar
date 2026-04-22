import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { ScrcpySidebarSession } from "./session";
import type { ExtensionConfig, WebviewToExtensionMessage } from "./types";

function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration("scrcpySidebar");
  return {
    adbHost: config.get("adbHost", "127.0.0.1"),
    adbPort: config.get("adbPort", 5037),
    maxFps: config.get("maxFps", 20),
    maxSize: config.get("maxSize", 1280),
    videoBitRate: config.get("videoBitRate", 3000000),
    videoCodec: config.get("videoCodec", "h264"),
    autoReconnectDelayMs: config.get("autoReconnectDelayMs", 3000),
    scrcpyServerVersion: config.get("scrcpyServerVersion", "3.3.4"),
    rootMode: config.get("rootMode", "always"),
    screenOffOnStart: config.get("screenOffOnStart", false),
    keepScreenAwake: config.get("keepScreenAwake", true),
    audioEnabled: config.get("audioEnabled", false),
    audioCodec: config.get("audioCodec", "aac"),
  };
}

class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private session?: ScrcpySidebarSession;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  dispose(): void {
    this.session?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    view.webview.html = await this.renderHtml(view.webview);

    view.onDidDispose(() => {
      this.session?.dispose();
      this.session = undefined;
    });

    view.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
      await this.ensureSession();
      await this.session?.handleMessage(message);
    });

    await this.ensureSession();
    await this.session?.initialize();
  }

  async selectDevice(): Promise<void> {
    await this.ensureSession();
    await this.session?.promptAndConnect();
  }

  async disconnect(): Promise<void> {
    await this.session?.handleMessage({ type: "disconnect" });
  }

  async reconnect(): Promise<void> {
    await this.ensureSession();
    await this.session?.handleMessage({ type: "reconnect" });
  }

  private async ensureSession(): Promise<void> {
    if (!this.view || this.session) {
      return;
    }
    this.session = new ScrcpySidebarSession(this.context, this.output, getConfig(), this.view.webview);
  }

  private async renderHtml(webview: vscode.Webview): Promise<string> {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
    const nonce = String(Date.now());
    const cssUri = vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.css");
    const css = await fs.readFile(cssUri.fsPath, "utf8");
    const icon = (kind: "settings" | "connect" | "back" | "home" | "tasks" | "power") => {
      switch (kind) {
        case "settings":
          return `<span class="icon-glyph" aria-hidden="true">⚙</span>`;
        case "connect":
          return `<span class="icon-glyph" aria-hidden="true">◎</span>`;
        case "back":
          return `<span class="icon-glyph" aria-hidden="true">‹</span>`;
        case "home":
          return `<span class="icon-glyph" aria-hidden="true">⌂</span>`;
        case "tasks":
          return `<span class="icon-glyph" aria-hidden="true">▢</span>`;
        case "power":
          return `<span class="icon-glyph" aria-hidden="true">⏻</span>`;
      }
    };
    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style nonce="${nonce}">${css}</style>
    <title>Scrcpy Sidebar</title>
  </head>
  <body>
    <div class="app-shell">
      <section id="playerPage" class="page active">
        <div class="screen-wrap">
          <div class="screen-shell">
            <div class="screen-header">
              <div class="screen-title-line">
                <strong id="deviceLabel">No device</strong>
                <span id="deviceSub">Waiting for adb devices</span>
              </div>
              <div class="header-actions">
                <span class="badge" id="statusBadge">Idle</span>
                <span class="badge mode" id="modeBadge">Pending</span>
                <button id="connectBtn" class="icon-button subtle" aria-label="连接设备" title="连接设备">
                  ${icon("connect")}
                </button>
                <button id="settingsBtn" class="icon-button subtle" aria-label="设置">
                  ${icon("settings")}
                </button>
              </div>
            </div>
            <div class="screen-frame">
              <div class="screen-notch"></div>
            </div>
            <div class="screen-stage">
              <canvas id="screen"></canvas>
              <div id="overlay" class="overlay" aria-hidden="true"></div>
            </div>
            <div class="floating-actions">
              <button id="backBtn" class="icon-button" aria-label="返回">
                ${icon("back")}
              </button>
              <button id="homeBtn" class="icon-button" aria-label="主页">
                ${icon("home")}
              </button>
              <button id="tasksBtn" class="icon-button" aria-label="任务">
                ${icon("tasks")}
              </button>
              <button id="powerBtn" class="icon-button" aria-label="电源">
                ${icon("power")}
              </button>
            </div>
          </div>
          <div id="statusText" class="visually-hidden">正在等待设备</div>
        </div>
      </section>

      <section id="settingsPage" class="page settings-page">
        <div class="settings-panel">
          <div class="settings-topbar">
            <button id="backToPlayerBtn" class="icon-button" aria-label="返回播放器">
              ${icon("back")}
            </button>
            <div class="settings-heading">
              <strong>播放设置</strong>
              <span class="mini" id="detail">Ready</span>
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-grid">
              <label>FPS
                <input id="fpsInput" type="number" min="0" step="1" value="20" />
              </label>
              <label>尺寸
                <input id="sizeInput" type="number" min="0" step="100" value="1280" />
              </label>
              <label>码率
                <input id="bitrateInput" type="number" min="1000000" step="500000" value="3000000" />
              </label>
              <label>编码
                <select id="codecInput">
                  <option value="h264">H.264</option>
                  <option value="h265">H.265</option>
                  <option value="av1">AV1</option>
                </select>
              </label>
              <label>控制权限
                <select id="rootModeInput">
                  <option value="always">默认使用 SU</option>
                  <option value="auto">自动切换</option>
                  <option value="never">不使用 SU</option>
                </select>
              </label>
              <label class="checkbox-row">
                <input id="screenOffInput" type="checkbox" />
                <span>启动后熄屏</span>
              </label>
              <label class="checkbox-row">
                <input id="keepAwakeInput" type="checkbox" />
                <span>连接期间保持常亮</span>
              </label>
              <label class="checkbox-row">
                <input id="audioEnabledInput" type="checkbox" />
                <span>启用音频（实验性）</span>
              </label>
              <label>音频编码
                <select id="audioCodecInput">
                  <option value="aac">AAC</option>
                  <option value="opus">Opus</option>
                </select>
              </label>
            </div>
          </div>

          <div class="settings-section utility-actions">
            <button id="reconnectBtn">重连</button>
            <button id="applyBtn" class="primary">应用设置</button>
          </div>

          <div class="settings-footer">
            <span id="metrics">FPS: 0</span>
            <span class="mini">修改参数会自动重连视频流</span>
          </div>
        </div>
      </section>
    </div>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Scrcpy Sidebar");
  const provider = new SidebarProvider(context, output);

  context.subscriptions.push(
    output,
    provider,
    vscode.window.registerWebviewViewProvider("scrcpySidebar.view", provider),
    vscode.commands.registerCommand("scrcpySidebar.selectDevice", async () => {
      await provider.selectDevice();
    }),
    vscode.commands.registerCommand("scrcpySidebar.disconnect", async () => {
      await provider.disconnect();
    }),
    vscode.commands.registerCommand("scrcpySidebar.reconnect", async () => {
      await provider.reconnect();
    }),
  );
}

export function deactivate(): void {}
