import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { Readable } from "node:stream";
import * as vscode from "vscode";
import {
  AdbNoneProtocolSpawner,
  AdbServerClient,
  type AdbServerClient as AdbServerClientType,
} from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { AdbScrcpyClient, AdbScrcpyExitedError, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidKeyEventMeta,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  AndroidScreenPowerMode,
  DefaultServerPath,
  ScrcpyInstanceId,
  ScrcpyPointerId,
  type ScrcpyMediaStreamPacket,
} from "@yume-chan/scrcpy";
import type {
  DeviceSummary,
  ExtensionConfig,
  ExtensionToWebviewMessage,
  StreamConfig,
  StreamStartPayload,
  VideoPacketPayload,
  WebviewToExtensionMessage,
} from "./types";

interface WebviewLike {
  postMessage(message: ExtensionToWebviewMessage): Thenable<boolean>;
}

function isIpEndpoint(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/.test(value.trim());
}

function toSummary(device: AdbServerClientType.Device): DeviceSummary {
  const label = [device.model, device.device, device.product].filter(Boolean).join(" / ");
  return {
    serial: device.serial,
    state: device.state,
    name: label || device.serial,
    transportId: device.transportId.toString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellEscape(argument: string): string {
  return `'${argument.replace(/'/g, `'\"'\"'`)}'`;
}

export class ScrcpySidebarSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly client: AdbServerClient;
  private readonly webview: WebviewLike;
  private currentSerial?: string;
  private reconnectTimer?: NodeJS.Timeout;
  private manuallyDisconnected = false;
  private scrcpyClient?: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>;
  private scrcpyAbort = new AbortController();
  private videoLoop?: Promise<void>;
  private currentStreamConfig: StreamConfig;
  private currentRootMode: "auto" | "always" | "never";
  private currentDeviceName = "";
  private streamSize = { width: 0, height: 0 };
  private videoPacketsSent = 0;
  private isPointerDown = false;
  private rootAvailable?: boolean;
  private activeControlMode: "standard" | "root" = "standard";
  private forcedControlMode?: "standard" | "root";
  private rootUpgradeScheduled = false;
  private lastScrcpyLogs: string[] = [];
  private connectInFlight = false;
  private screenPowerOffPending = false;
  private codecFallbackScheduled = false;
  private previousScreenTimeout?: string;
  private screenTimeoutWatchdog?: ChildProcess;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly config: ExtensionConfig,
    webview: WebviewLike,
  ) {
    this.webview = webview;
    this.client = new AdbServerClient(
      new AdbServerNodeTcpConnector({
        host: config.adbHost,
        port: config.adbPort,
      }),
    );
    this.currentStreamConfig = {
      maxFps: config.maxFps,
      maxSize: config.maxSize,
      videoBitRate: config.videoBitRate,
      videoCodec: config.videoCodec,
      screenOffOnStart: config.screenOffOnStart,
      keepScreenAwake: config.keepScreenAwake,
      audioEnabled: config.audioEnabled,
      audioCodec: config.audioCodec,
    };
    this.currentRootMode = config.rootMode;
  }

  async initialize(): Promise<void> {
    await this.refreshDevices();
  }

  dispose(): void {
    void this.stop("Session disposed");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.scrcpyAbort.abort();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.refreshDevices();
        return;
      case "select-device":
        await this.promptAndConnect();
        return;
      case "disconnect":
        this.manuallyDisconnected = true;
        await this.stop("Disconnected");
        return;
      case "reconnect":
        this.manuallyDisconnected = false;
        await this.reconnect();
        return;
      case "video-ready":
        await this.applyPendingScreenPowerOff();
        return;
      case "decoder-error":
        await this.handleDecoderError(message.detail);
        return;
      case "key":
        await this.injectKey(message.key);
        return;
      case "keyboard-text":
        await this.injectKeyboardText(message.text);
        return;
      case "keyboard-key":
        await this.injectKeyboardKey(message.key);
        return;
      case "keyboard-event":
        await this.injectKeyboardEvent(message);
        return;
      case "apply-config":
        this.currentStreamConfig = {
          ...this.currentStreamConfig,
          ...message.config,
        };
        if (message.config.rootMode) {
          this.currentRootMode = message.config.rootMode;
        }
        if (this.currentSerial) {
          await this.reconnect();
        }
        return;
      case "pointer":
        await this.injectPointer(message);
        return;
    }
  }

  async promptAndConnect(): Promise<void> {
    const devices = await this.getDevices();
    const selected = await this.pickDevice(devices);
    if (!selected) {
      return;
    }

    if (selected.connectAddress) {
      await this.connectAddress(selected.connectAddress);
      return;
    }

    if (selected.device) {
      await this.connect(selected.device.serial, selected.device.name);
    }
  }

  async refreshDevices(): Promise<void> {
    const devices = await this.getDevices();
    await this.post({
      type: "devices",
      devices,
      currentSerial: this.currentSerial,
    });
  }

  async reconnect(): Promise<void> {
    if (!this.currentSerial) {
      await this.refreshDevices();
      return;
    }

    const serial = this.currentSerial;
    const name = this.currentDeviceName || serial;
    await this.stop("Reconnecting");
    await this.connect(serial, name, this.forcedControlMode);
  }

  private async getDevices(): Promise<DeviceSummary[]> {
    try {
      const devices = await this.client.getDevices();
      return devices.map(toSummary);
    } catch (error) {
      this.output.appendLine(`getDevices failed: ${String(error)}`);
      await this.post({
        type: "error",
        message: `ADB 不可用: ${String(error)}`,
      });
      return [];
    }
  }

  private async pickDevice(devices: DeviceSummary[]): Promise<
    | { device: DeviceSummary; connectAddress?: undefined }
    | { device?: undefined; connectAddress: string }
    | undefined
  > {
    return await new Promise((resolve) => {
      type DevicePickItem = vscode.QuickPickItem & { device?: DeviceSummary; connectAddress?: string };
      const quickPick = vscode.window.createQuickPick<DevicePickItem>();
      quickPick.title = "Select Android Device";
      quickPick.placeholder = "输入关键字过滤，或输入 IP / IP:PORT 进行 adb connect";
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;

      const rebuildItems = () => {
        const filter = quickPick.value.trim().toLowerCase();
        const baseItems: DevicePickItem[] = devices
          .filter((device) => {
            if (!filter) {
              return true;
            }
            return [device.serial, device.name, device.state].some((part) => part.toLowerCase().includes(filter));
          })
          .map((device) => ({
            label: device.name,
            description: `${device.serial} · ${device.state}`,
            detail: device.transportId ? `transportId=${device.transportId}` : "",
            device,
          }));

        if (isIpEndpoint(quickPick.value)) {
          baseItems.unshift({
            label: `连接 ${quickPick.value.trim()}`,
            description: "通过 adb connect 连接网络设备",
            detail: "按回车立即尝试",
            connectAddress: quickPick.value.trim(),
          });
        }

        quickPick.items = baseItems;
      };

      quickPick.onDidChangeValue(rebuildItems);
      quickPick.onDidAccept(() => {
        const [item] = quickPick.selectedItems;
        quickPick.hide();
        if (!item) {
          resolve(undefined);
          return;
        }
        if (item.connectAddress) {
          resolve({ connectAddress: item.connectAddress });
          return;
        }
        if (item.device) {
          resolve({ device: item.device });
          return;
        }
        resolve(undefined);
      });
      quickPick.onDidHide(() => {
        resolve(undefined);
        quickPick.dispose();
      });
      rebuildItems();
      quickPick.show();
    });
  }

  private async connectAddress(address: string): Promise<void> {
    const normalized = address.includes(":") ? address : `${address}:5555`;
    await this.post({
      type: "state",
      status: "connecting",
      detail: `Connecting ${normalized}`,
      mode: "pending",
    });

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `adb connect ${normalized}`,
      },
      async () => {
        return await new Promise<string>((resolve) => {
          execFile("adb", ["connect", normalized], (error, stdout, stderr) => {
            resolve((stdout || stderr || error?.message || "").trim());
          });
        });
      },
    );

    this.output.appendLine(`adb connect ${normalized}: ${result}`);
    await this.refreshDevices();

    const devices = await this.getDevices();
    const match = devices.find((device) => device.serial === normalized || device.serial === address);
    if (match) {
      await this.connect(match.serial, match.name);
      return;
    }

    await this.post({
      type: "error",
      message: `连接失败: ${result || normalized}`,
    });
  }

  private async connect(serial: string, name: string, forcedMode?: "standard" | "root"): Promise<void> {
    if (this.connectInFlight) {
      this.output.appendLine(`connect skipped: already connecting to ${this.currentSerial ?? serial}`);
      return;
    }

    this.connectInFlight = true;
    this.manuallyDisconnected = false;
    this.currentSerial = serial;
    this.currentDeviceName = name;
    this.forcedControlMode = forcedMode;
    this.rootUpgradeScheduled = false;
    this.lastScrcpyLogs = [];
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    await this.stop();
    await this.post({
      type: "state",
      status: "connecting",
      detail: `Connecting ${serial}`,
      mode: "pending",
    });
    await this.post({
      type: "devices",
      devices: await this.getDevices(),
      currentSerial: serial,
    });

    try {
      const adb = await this.client.createAdb({ serial });
      const serverPath = await this.pushServerToDevice(adb, serial);
      const rootAvailable = await this.checkRoot(adb);
      const preferredMode =
        forcedMode
          ? forcedMode
          : this.currentRootMode === "always"
          ? "root"
          : this.currentRootMode === "never"
            ? "standard"
            : "standard";
      const fallbackMode =
        !forcedMode && this.currentRootMode === "auto" && rootAvailable
          ? "root"
          : undefined;

      const { scrcpyClient, controlMode } = await this.startScrcpyWithFallback(adb, serverPath, preferredMode, fallbackMode);
      this.activeControlMode = controlMode;
      this.scrcpyClient = scrcpyClient;
      void (async () => {
        const outputReader = scrcpyClient.output.getReader();
        try {
          while (true) {
            const { done, value } = await outputReader.read();
            if (done) {
              break;
            }
            this.output.appendLine(`[scrcpy] ${value}`);
            this.lastScrcpyLogs.push(value);
            if (this.lastScrcpyLogs.length > 12) {
              this.lastScrcpyLogs.shift();
            }
            this.handleScrcpyLogLine(value);
          }
        } catch {
          // ignore log stream errors
        } finally {
          outputReader.releaseLock();
        }
      })();
      const videoStream = await scrcpyClient.videoStream;
      const metadataWidth = videoStream.metadata.width ?? 0;
      const metadataHeight = videoStream.metadata.height ?? 0;
      this.streamSize = {
        width: videoStream.width || metadataWidth,
        height: videoStream.height || metadataHeight,
      };
      this.videoPacketsSent = 0;
      this.screenPowerOffPending = !!this.currentStreamConfig.screenOffOnStart;

      const startPayload: StreamStartPayload = {
        serial,
        deviceName: name,
        width: videoStream.width || metadataWidth,
        height: videoStream.height || metadataHeight,
        codecId: videoStream.metadata.codec,
        config: {
          ...this.currentStreamConfig,
          rootMode: this.currentRootMode,
        },
        controlMode,
      };
      await this.post({ type: "stream-start", payload: startPayload });
      await this.post({
        type: "state",
        status: "streaming",
        detail: `${name} · ${serial}`,
        mode: controlMode,
      });
      await this.enableKeepAwakeIfNeeded(adb, serial);

      videoStream.sizeChanged(({ width, height }) => {
        this.streamSize = { width, height };
      });

      const reader = videoStream.stream.getReader();
      this.videoLoop = (async () => {
        try {
          while (!this.scrcpyAbort.signal.aborted) {
            const { done, value } = await reader.read();
            if (done || !value) {
              break;
            }
            const data = value.data;
            const packet: VideoPacketPayload = {
              type: value.type,
              data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
              keyframe: value.type === "data" ? value.keyframe : undefined,
              pts: value.type === "data" && value.pts !== undefined ? value.pts.toString() : undefined,
            };
            this.videoPacketsSent += 1;
            void this.webview.postMessage({ type: "video", packet });
          }
        } finally {
          reader.releaseLock();
        }
      })();

      scrcpyClient.exited
        .then(() => {
          const tail = this.lastScrcpyLogs.at(-1);
          return this.handleDisconnect(tail ? `scrcpy exited · ${tail}` : "scrcpy exited");
        })
        .catch((error) => this.handleDisconnect(String(error)));
    } catch (error) {
      this.output.appendLine(`connect failed: ${String(error)}`);
      if (error && typeof error === "object" && "output" in error) {
        this.output.appendLine(`scrcpy output: ${JSON.stringify((error as { output?: unknown }).output)}`);
      }
      await this.post({
        type: "error",
        message: `连接 ${serial} 失败: ${String(error)}`,
      });
      await this.scheduleReconnect();
    } finally {
      this.connectInFlight = false;
    }
  }

  private async stop(detail?: string): Promise<void> {
    await this.restoreScreenTimeout();
    if (this.scrcpyClient) {
      try {
        await this.scrcpyClient.close();
      } catch {
        // ignore
      }
      this.scrcpyClient = undefined;
    }

    this.scrcpyAbort.abort();
    this.scrcpyAbort = new AbortController();
    this.screenPowerOffPending = false;

    if (this.videoLoop) {
      try {
        await this.videoLoop;
      } catch {
        // ignore
      }
      this.videoLoop = undefined;
    }

    if (detail) {
      await this.post({ type: "stream-stop", detail });
      await this.post({ type: "state", status: "idle", detail, mode: "pending" });
    }
  }

  private async handleDisconnect(detail: string): Promise<void> {
    this.output.appendLine(`stream disconnected: ${detail}; packetsSent=${this.videoPacketsSent}`);
    await this.post({ type: "stream-stop", detail });
    await this.post({ type: "state", status: "disconnected", detail, mode: this.activeControlMode });
    if (!this.manuallyDisconnected && !this.rootUpgradeScheduled) {
      await this.scheduleReconnect();
    }
  }

  private async scheduleReconnect(): Promise<void> {
    if (!this.currentSerial || this.manuallyDisconnected || this.reconnectTimer) {
      return;
    }

    const serial = this.currentSerial;
    const name = this.currentDeviceName || serial;
    await this.post({
      type: "state",
      status: "reconnecting",
      detail: `${serial} in ${this.config.autoReconnectDelayMs}ms`,
      mode: this.activeControlMode,
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (isIpEndpoint(serial)) {
        await this.connect(serial, name, this.forcedControlMode);
        return;
      }

      try {
        await this.client.reconnectDevice({ serial });
      } catch (error) {
        this.output.appendLine(`adb reconnect ${serial} failed: ${String(error)}`);
      }
      await sleep(500);
      await this.connect(serial, name);
    }, this.config.autoReconnectDelayMs);
  }

  private async injectPointer(message: Extract<WebviewToExtensionMessage, { type: "pointer" }>): Promise<void> {
    const controller = this.scrcpyClient?.controller;
    if (!controller) {
      return;
    }

    if (!this.streamSize.width || !this.streamSize.height) {
      return;
    }

    if (message.phase === "move" && !this.isPointerDown) {
      return;
    }

    const action =
      message.phase === "down"
        ? AndroidMotionEventAction.Down
        : message.phase === "move"
          ? AndroidMotionEventAction.Move
          : AndroidMotionEventAction.Up;

    const pointerX = Math.max(0, Math.min(this.streamSize.width, Math.round(message.x)));
    const pointerY = Math.max(0, Math.min(this.streamSize.height, Math.round(message.y)));
    const pressure = message.phase === "up" ? 0 : Math.max(0.1, Math.min(1, message.pressure || 1));

    try {
      await controller.injectTouch({
        action,
        pointerId: ScrcpyPointerId.Finger,
        pointerX,
        pointerY,
        videoWidth: this.streamSize.width,
        videoHeight: this.streamSize.height,
        pressure,
        actionButton: AndroidMotionEventButton.None,
        buttons: AndroidMotionEventButton.None,
      });

      this.isPointerDown = message.phase !== "up";
    } catch (error) {
      this.output.appendLine(`injectTouch failed: ${String(error)}`);
    }
  }

  private async injectKey(key: "back" | "home" | "appSwitch" | "power"): Promise<void> {
    const controller = this.scrcpyClient?.controller;
    const serial = this.currentSerial;
    if (!serial) {
      return;
    }

    const keyCode =
      key === "back"
        ? AndroidKeyCode.AndroidBack
        : key === "home"
          ? AndroidKeyCode.AndroidHome
          : key === "appSwitch"
            ? AndroidKeyCode.AndroidAppSwitch
            : AndroidKeyCode.Power;

    if (key === "power") {
      await this.injectKeyViaAdb(serial, "26");
      return;
    }

    try {
      if (!controller) {
        throw new Error("scrcpy controller unavailable");
      }
      await controller.injectKeyCode({
        action: AndroidKeyEventAction.Down,
        keyCode,
        repeat: 0,
        metaState: AndroidKeyEventMeta.None,
      });
      await controller.injectKeyCode({
        action: AndroidKeyEventAction.Up,
        keyCode,
        repeat: 0,
        metaState: AndroidKeyEventMeta.None,
      });
    } catch (error) {
      this.output.appendLine(`injectKey failed (${key}): ${String(error)}`);
      const fallback =
        key === "back" ? "4" :
        key === "home" ? "3" :
        key === "appSwitch" ? "187" :
        "26";
      await this.injectKeyViaAdb(serial, fallback);
    }
  }

  private async injectKeyboardText(text: string): Promise<void> {
    const controller = this.scrcpyClient?.controller;
    const serial = this.currentSerial;
    if (!serial || !text) {
      return;
    }

    try {
      if (!controller) {
        throw new Error("scrcpy controller unavailable");
      }
      await controller.injectText(text);
    } catch (error) {
      this.output.appendLine(`injectText failed (${JSON.stringify(text)}): ${String(error)}`);
      await this.injectTextViaAdb(serial, text);
    }
  }

  private async injectKeyboardKey(key: string): Promise<void> {
    const mapping: Record<string, { android: (typeof AndroidKeyCode)[keyof typeof AndroidKeyCode]; adb: string }> = {
      Enter: { android: AndroidKeyCode.Enter, adb: "66" },
      Backspace: { android: AndroidKeyCode.Backspace, adb: "67" },
      Delete: { android: AndroidKeyCode.Delete, adb: "112" },
      Tab: { android: AndroidKeyCode.Tab, adb: "61" },
      Escape: { android: AndroidKeyCode.Escape, adb: "111" },
      ArrowUp: { android: AndroidKeyCode.ArrowUp, adb: "19" },
      ArrowDown: { android: AndroidKeyCode.ArrowDown, adb: "20" },
      ArrowLeft: { android: AndroidKeyCode.ArrowLeft, adb: "21" },
      ArrowRight: { android: AndroidKeyCode.ArrowRight, adb: "22" },
      Home: { android: AndroidKeyCode.Home, adb: "122" },
      End: { android: AndroidKeyCode.End, adb: "123" },
      PageUp: { android: AndroidKeyCode.PageUp, adb: "92" },
      PageDown: { android: AndroidKeyCode.PageDown, adb: "93" },
      Insert: { android: AndroidKeyCode.Insert, adb: "124" },
      Space: { android: AndroidKeyCode.Space, adb: "62" },
    };

    const target = mapping[key];
    if (!target) {
      return;
    }

    const controller = this.scrcpyClient?.controller;
    const serial = this.currentSerial;
    if (!serial) {
      return;
    }

    try {
      if (!controller) {
        throw new Error("scrcpy controller unavailable");
      }
      await controller.injectKeyCode({
        action: AndroidKeyEventAction.Down,
        keyCode: target.android,
        repeat: 0,
        metaState: AndroidKeyEventMeta.None,
      });
      await controller.injectKeyCode({
        action: AndroidKeyEventAction.Up,
        keyCode: target.android,
        repeat: 0,
        metaState: AndroidKeyEventMeta.None,
      });
    } catch (error) {
      this.output.appendLine(`injectKeyboardKey failed (${key}): ${String(error)}`);
      await this.injectKeyViaAdb(serial, target.adb);
    }
  }

  private async injectKeyboardEvent(
    message: Extract<WebviewToExtensionMessage, { type: "keyboard-event" }>,
  ): Promise<void> {
    const controller = this.scrcpyClient?.controller;
    const serial = this.currentSerial;
    if (!serial || message.repeat) {
      return;
    }

    const metaState = ((
      (message.altKey ? AndroidKeyEventMeta.Alt : 0) |
      (message.shiftKey ? AndroidKeyEventMeta.Shift : 0) |
      (message.ctrlKey ? AndroidKeyEventMeta.Ctrl : 0) |
      (message.metaKey ? AndroidKeyEventMeta.Meta : 0)
    ) as AndroidKeyEventMeta);

    const target = this.mapKeyboardCode(message.code, message.key);
    if (!target) {
      return;
    }

    try {
      if (!controller) {
        throw new Error("scrcpy controller unavailable");
      }
      await controller.injectKeyCode({
        action: message.action === "down" ? AndroidKeyEventAction.Down : AndroidKeyEventAction.Up,
        keyCode: target.android,
        repeat: 0,
        metaState,
      });
    } catch (error) {
      this.output.appendLine(`injectKeyboardEvent failed (${message.code}/${message.key}): ${String(error)}`);
      if (message.action === "down") {
        await this.injectKeyViaAdb(serial, target.adb);
      }
    }
  }

  private mapKeyboardCode(
    code: string,
    key: string,
  ): { android: (typeof AndroidKeyCode)[keyof typeof AndroidKeyCode]; adb: string } | undefined {
    const byCode: Record<string, { android: (typeof AndroidKeyCode)[keyof typeof AndroidKeyCode]; adb: string }> = {
      Backquote: { android: AndroidKeyCode.Backquote, adb: "68" },
      Minus: { android: AndroidKeyCode.Minus, adb: "69" },
      Equal: { android: AndroidKeyCode.Equal, adb: "70" },
      BracketLeft: { android: AndroidKeyCode.BracketLeft, adb: "71" },
      BracketRight: { android: AndroidKeyCode.BracketRight, adb: "72" },
      Backslash: { android: AndroidKeyCode.Backslash, adb: "73" },
      Semicolon: { android: AndroidKeyCode.Semicolon, adb: "74" },
      Quote: { android: AndroidKeyCode.Quote, adb: "75" },
      Comma: { android: AndroidKeyCode.Comma, adb: "55" },
      Period: { android: AndroidKeyCode.Period, adb: "56" },
      Slash: { android: AndroidKeyCode.Slash, adb: "76" },
      Space: { android: AndroidKeyCode.Space, adb: "62" },
      Tab: { android: AndroidKeyCode.Tab, adb: "61" },
      Enter: { android: AndroidKeyCode.Enter, adb: "66" },
      NumpadEnter: { android: AndroidKeyCode.NumpadEnter, adb: "160" },
      Backspace: { android: AndroidKeyCode.Backspace, adb: "67" },
      Delete: { android: AndroidKeyCode.Delete, adb: "112" },
      Escape: { android: AndroidKeyCode.Escape, adb: "111" },
      ArrowUp: { android: AndroidKeyCode.ArrowUp, adb: "19" },
      ArrowDown: { android: AndroidKeyCode.ArrowDown, adb: "20" },
      ArrowLeft: { android: AndroidKeyCode.ArrowLeft, adb: "21" },
      ArrowRight: { android: AndroidKeyCode.ArrowRight, adb: "22" },
      Home: { android: AndroidKeyCode.Home, adb: "122" },
      End: { android: AndroidKeyCode.End, adb: "123" },
      PageUp: { android: AndroidKeyCode.PageUp, adb: "92" },
      PageDown: { android: AndroidKeyCode.PageDown, adb: "93" },
      Insert: { android: AndroidKeyCode.Insert, adb: "124" },
      ShiftLeft: { android: AndroidKeyCode.ShiftLeft, adb: "59" },
      ShiftRight: { android: AndroidKeyCode.ShiftRight, adb: "60" },
      ControlLeft: { android: AndroidKeyCode.ControlLeft, adb: "113" },
      ControlRight: { android: AndroidKeyCode.ControlRight, adb: "114" },
      AltLeft: { android: AndroidKeyCode.AltLeft, adb: "57" },
      AltRight: { android: AndroidKeyCode.AltRight, adb: "58" },
      MetaLeft: { android: AndroidKeyCode.MetaLeft, adb: "117" },
      MetaRight: { android: AndroidKeyCode.MetaRight, adb: "118" },
      CapsLock: { android: AndroidKeyCode.CapsLock, adb: "115" },
      ContextMenu: { android: AndroidKeyCode.ContextMenu, adb: "82" },
      F1: { android: AndroidKeyCode.F1, adb: "131" },
      F2: { android: AndroidKeyCode.F2, adb: "132" },
      F3: { android: AndroidKeyCode.F3, adb: "133" },
      F4: { android: AndroidKeyCode.F4, adb: "134" },
      F5: { android: AndroidKeyCode.F5, adb: "135" },
      F6: { android: AndroidKeyCode.F6, adb: "136" },
      F7: { android: AndroidKeyCode.F7, adb: "137" },
      F8: { android: AndroidKeyCode.F8, adb: "138" },
      F9: { android: AndroidKeyCode.F9, adb: "139" },
      F10: { android: AndroidKeyCode.F10, adb: "140" },
      F11: { android: AndroidKeyCode.F11, adb: "141" },
      F12: { android: AndroidKeyCode.F12, adb: "142" },
      Numpad0: { android: AndroidKeyCode.Numpad0, adb: "144" },
      Numpad1: { android: AndroidKeyCode.Numpad1, adb: "145" },
      Numpad2: { android: AndroidKeyCode.Numpad2, adb: "146" },
      Numpad3: { android: AndroidKeyCode.Numpad3, adb: "147" },
      Numpad4: { android: AndroidKeyCode.Numpad4, adb: "148" },
      Numpad5: { android: AndroidKeyCode.Numpad5, adb: "149" },
      Numpad6: { android: AndroidKeyCode.Numpad6, adb: "150" },
      Numpad7: { android: AndroidKeyCode.Numpad7, adb: "151" },
      Numpad8: { android: AndroidKeyCode.Numpad8, adb: "152" },
      Numpad9: { android: AndroidKeyCode.Numpad9, adb: "153" },
      NumpadAdd: { android: AndroidKeyCode.NumpadAdd, adb: "157" },
      NumpadSubtract: { android: AndroidKeyCode.NumpadSubtract, adb: "156" },
      NumpadMultiply: { android: AndroidKeyCode.NumpadMultiply, adb: "155" },
      NumpadDivide: { android: AndroidKeyCode.NumpadDivide, adb: "154" },
      NumpadDecimal: { android: AndroidKeyCode.NumpadDecimal, adb: "158" },
    };

    const direct = byCode[code];
    if (direct) {
      return direct;
    }

    if (/^Key[A-Z]$/.test(code)) {
      const android = AndroidKeyCode[code as keyof typeof AndroidKeyCode];
      if (android !== undefined) {
        return { android, adb: String(android) };
      }
    }

    if (/^Digit[0-9]$/.test(code)) {
      const android = AndroidKeyCode[code as keyof typeof AndroidKeyCode];
      if (android !== undefined) {
        return { android, adb: String(android) };
      }
    }

    if (key === "Space") {
      return { android: AndroidKeyCode.Space, adb: "62" };
    }

    return undefined;
  }

  private async injectKeyViaAdb(serial: string, keyCode: string): Promise<void> {
    try {
      const adb = await this.client.createAdb({ serial });
      const preferRoot = this.activeControlMode === "root" || this.currentRootMode === "always";
      await this.runDeviceCommand(adb, ["input", "keyevent", keyCode], preferRoot);
      this.output.appendLine(`injectKey fallback via adb shell input keyevent ${keyCode}`);
    } catch (error) {
      this.output.appendLine(`injectKey fallback failed (${keyCode}): ${String(error)}`);
    }
  }

  private async injectTextViaAdb(serial: string, text: string): Promise<void> {
    try {
      const adb = await this.client.createAdb({ serial });
      const preferRoot = this.activeControlMode === "root" || this.currentRootMode === "always";
      const escaped = text
        .replace(/ /g, "%s")
        .replace(/(["'`\\$&|;<>(){}\[\]])/g, "\\$1");
      await this.runDeviceCommand(adb, ["input", "text", escaped], preferRoot);
      this.output.appendLine(`injectText fallback via adb shell input text ${JSON.stringify(text)}`);
    } catch (error) {
      this.output.appendLine(`injectText fallback failed (${JSON.stringify(text)}): ${String(error)}`);
    }
  }

  private async applyPendingScreenPowerOff(): Promise<void> {
    if (!this.screenPowerOffPending) {
      return;
    }

    const controller = this.scrcpyClient?.controller;
    if (!controller) {
      return;
    }

    this.screenPowerOffPending = false;
    try {
      await controller.setScreenPowerMode(AndroidScreenPowerMode.Off);
      this.output.appendLine("device screen turned off after first video frame");
    } catch (error) {
      this.output.appendLine(`setScreenPowerMode failed: ${String(error)}`);
    }
  }

  private async pushServerToDevice(adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>, serial: string): Promise<string> {
    const localServerBin = path.join(this.context.extensionPath, "media", "scrcpy-server.bin");
    await fs.access(localServerBin);
    this.output.appendLine(`pushing scrcpy server to ${serial}: ${DefaultServerPath}`);
    const serverStream = Readable.toWeb(createReadStream(localServerBin)) as any;
    await AdbScrcpyClient.pushServer(
      adb,
      serverStream,
      DefaultServerPath,
    );
    return DefaultServerPath;
  }

  private async runDeviceCommand(
    adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>,
    command: string[],
    preferRoot = false,
  ): Promise<string> {
    if (preferRoot) {
      return await adb.subprocess.noneProtocol.spawnWaitText([
        "su",
        "-c",
        shellEscape(command.join(" ")),
      ]);
    }
    return await adb.subprocess.noneProtocol.spawnWaitText(command);
  }

  private async readScreenTimeout(adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>): Promise<string | undefined> {
    try {
      const result = (await this.runDeviceCommand(adb, ["settings", "get", "system", "screen_off_timeout"])).trim();
      return result || undefined;
    } catch (error) {
      this.output.appendLine(`read screen_off_timeout failed: ${String(error)}`);
      return undefined;
    }
  }

  private async writeScreenTimeout(
    adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>,
    value: string,
  ): Promise<void> {
    const preferRoot = this.activeControlMode === "root" || this.currentRootMode === "always";
    try {
      await this.runDeviceCommand(adb, ["settings", "put", "system", "screen_off_timeout", value], preferRoot);
    } catch (error) {
      this.output.appendLine(`set screen_off_timeout failed: ${String(error)}`);
      throw error;
    }
  }

  private async deleteScreenTimeout(adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>): Promise<void> {
    const preferRoot = this.activeControlMode === "root" || this.currentRootMode === "always";
    try {
      await this.runDeviceCommand(adb, ["settings", "delete", "system", "screen_off_timeout"], preferRoot);
    } catch (error) {
      this.output.appendLine(`delete screen_off_timeout failed: ${String(error)}`);
      throw error;
    }
  }

  private stopScreenTimeoutWatchdog(): void {
    if (!this.screenTimeoutWatchdog) {
      return;
    }
    try {
      process.kill(this.screenTimeoutWatchdog.pid ?? -1, "SIGTERM");
    } catch {
      // ignore
    }
    this.screenTimeoutWatchdog = undefined;
  }

  private startScreenTimeoutWatchdog(serial: string, previousValue: string): void {
    this.stopScreenTimeoutWatchdog();
    const quotedHost = JSON.stringify(this.config.adbHost);
    const quotedSerial = JSON.stringify(serial);
    const quotedPrevious = JSON.stringify(previousValue);
    const restoreArgs =
      previousValue === "null"
        ? `["-H", ${quotedHost}, "-P", ${this.config.adbPort}, "-s", ${quotedSerial}, "shell", "settings", "delete", "system", "screen_off_timeout"]`
        : `["-H", ${quotedHost}, "-P", ${this.config.adbPort}, "-s", ${quotedSerial}, "shell", "settings", "put", "system", "screen_off_timeout", ${quotedPrevious}]`;
    const script = `
const { execFileSync } = require("node:child_process");
const parentPid = ${process.pid};
while (true) {
  try {
    process.kill(parentPid, 0);
  } catch {
    try {
      execFileSync("adb", ${restoreArgs}, { stdio: "ignore" });
    } catch {}
    process.exit(0);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
}
`;
    try {
      this.screenTimeoutWatchdog = spawn(process.execPath, ["-e", script], {
        detached: true,
        stdio: "ignore",
      });
      this.screenTimeoutWatchdog.unref();
    } catch (error) {
      this.output.appendLine(`start screen timeout watchdog failed: ${String(error)}`);
    }
  }

  private async enableKeepAwakeIfNeeded(
    adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>,
    serial: string,
  ): Promise<void> {
    if (!this.currentStreamConfig.keepScreenAwake) {
      this.stopScreenTimeoutWatchdog();
      this.previousScreenTimeout = undefined;
      return;
    }

    const currentTimeout = await this.readScreenTimeout(adb);
    this.previousScreenTimeout = currentTimeout ?? "null";
    try {
      await this.writeScreenTimeout(adb, "2147483647");
      this.output.appendLine(`screen_off_timeout set to keep-awake value for ${serial}`);
      this.startScreenTimeoutWatchdog(serial, this.previousScreenTimeout);
    } catch {
      // already logged
    }
  }

  private async restoreScreenTimeout(): Promise<void> {
    this.stopScreenTimeoutWatchdog();
    if (!this.currentSerial || this.previousScreenTimeout === undefined) {
      this.previousScreenTimeout = undefined;
      return;
    }

    try {
      const adb = await this.client.createAdb({ serial: this.currentSerial });
      if (this.previousScreenTimeout === "null") {
        await this.deleteScreenTimeout(adb);
      } else {
        await this.writeScreenTimeout(adb, this.previousScreenTimeout);
      }
      this.output.appendLine(`screen_off_timeout restored for ${this.currentSerial}`);
    } catch (error) {
      this.output.appendLine(`restore screen_off_timeout failed: ${String(error)}`);
    } finally {
      this.previousScreenTimeout = undefined;
    }
  }

  private handleScrcpyLogLine(line: string): void {
    if (
      this.activeControlMode === "standard" &&
      this.currentRootMode === "auto" &&
      !this.rootUpgradeScheduled &&
      (
        line.includes("INJECT_EVENTS permission") ||
        line.includes("Security Settings") ||
        line.includes("Injecting input events requires")
      )
    ) {
      this.rootUpgradeScheduled = true;
      this.output.appendLine("permission denied in standard mode, scheduling automatic root reconnect");
      void this.post({
        type: "state",
        status: "elevating",
        detail: "Standard control denied, switching to root",
        mode: "pending",
      });
      void this.upgradeToRoot();
    }
  }

  private async upgradeToRoot(): Promise<void> {
    if (!this.currentSerial) {
      return;
    }

    const serial = this.currentSerial;
    const name = this.currentDeviceName || serial;

    try {
      await this.stop("Switching to root control");
      await this.connect(serial, name, "root");
    } finally {
      this.rootUpgradeScheduled = false;
    }
  }

  private async handleDecoderError(detail: string): Promise<void> {
    this.output.appendLine(`decoder error: ${detail}`);

    if (this.codecFallbackScheduled) {
      return;
    }

    const currentCodec = this.currentStreamConfig.videoCodec;
    if (currentCodec === "h264") {
      await this.post({
        type: "error",
        message: `浏览器视频解码失败: ${detail}`,
      });
      return;
    }

    this.codecFallbackScheduled = true;
    this.output.appendLine(`decoder failed with ${currentCodec}, falling back to h264`);
    this.currentStreamConfig = {
      ...this.currentStreamConfig,
      videoCodec: "h264",
    };
    await this.post({
      type: "state",
      status: "reconnecting",
      detail: `${currentCodec.toUpperCase()} 解码失败，正在切换到 H.264`,
      mode: this.activeControlMode,
    });

    try {
      await this.reconnect();
    } finally {
      this.codecFallbackScheduled = false;
    }
  }

  private createScrcpySpawner(
    adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>,
    mode: "standard" | "root",
  ): AdbNoneProtocolSpawner | undefined {
    if (mode === "standard") {
      return undefined;
    }
    this.output.appendLine("using root scrcpy spawner via su -c");
    return new AdbNoneProtocolSpawner((command, signal) => {
      const commandLine = command.join(" ");
      return adb.subprocess.noneProtocol.spawn([
        "su",
        "-c",
        shellEscape(commandLine),
      ], signal);
    });
  }

  private async checkRoot(adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>): Promise<boolean> {
    if (this.rootAvailable !== undefined) {
      return this.rootAvailable;
    }

    try {
      const result = await adb.subprocess.noneProtocol.spawnWaitText(["su", "-c", "id"]);
      this.rootAvailable = result.includes("uid=0");
    } catch {
      this.rootAvailable = false;
    }

    this.output.appendLine(`root available: ${this.rootAvailable}`);
    return this.rootAvailable;
  }

  private createOptions(spawner: AdbNoneProtocolSpawner | undefined): AdbScrcpyOptionsLatest<true> {
    return new AdbScrcpyOptionsLatest({
      scid: ScrcpyInstanceId.random(),
      video: true,
      audio: !!this.currentStreamConfig.audioEnabled,
      audioCodec: this.currentStreamConfig.audioCodec ?? "aac",
      control: true,
      cleanup: true,
      maxFps: this.currentStreamConfig.maxFps,
      maxSize: this.currentStreamConfig.maxSize,
      videoBitRate: this.currentStreamConfig.videoBitRate,
      videoCodec: this.currentStreamConfig.videoCodec,
      sendCodecMeta: true,
      sendDeviceMeta: true,
    }, {
      version: this.config.scrcpyServerVersion,
      spawner,
    });
  }

  private shouldRetryWithRoot(error: unknown): boolean {
    if (!(error instanceof AdbScrcpyExitedError)) {
      return false;
    }

    return error.output.some((line) =>
      line.includes("INJECT_EVENTS permission") ||
      line.includes("Security Settings") ||
      line.includes("Injecting input events requires"),
    );
  }

  private async startScrcpyWithFallback(
    adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>,
    serverPath: string,
    preferredMode: "standard" | "root",
    fallbackMode?: "standard" | "root",
  ): Promise<{ scrcpyClient: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>; controlMode: "standard" | "root" }> {
    const tryModes = fallbackMode && fallbackMode !== preferredMode
      ? [preferredMode, fallbackMode]
      : [preferredMode];

    let lastError: unknown;

    for (const mode of tryModes) {
      if (mode === "root" && !(await this.checkRoot(adb))) {
        continue;
      }

      await this.post({
        type: "state",
        status: mode === "standard" ? "connecting" : "elevating",
        detail: mode === "standard" ? "Trying standard control" : "Switching to root control",
        mode: mode === "standard" ? "standard" : "root",
      });

      try {
        const scrcpyClient = await AdbScrcpyClient.start(adb, serverPath, this.createOptions(this.createScrcpySpawner(adb, mode)));
        return { scrcpyClient, controlMode: mode };
      } catch (error) {
        lastError = error;
        this.output.appendLine(`scrcpy start failed (${mode}): ${String(error)}`);
        if (mode === "standard" && fallbackMode === "root" && this.shouldRetryWithRoot(error)) {
          this.output.appendLine("falling back to root mode because input injection was denied");
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async post(message: ExtensionToWebviewMessage): Promise<void> {
    await this.webview.postMessage(message);
  }
}
