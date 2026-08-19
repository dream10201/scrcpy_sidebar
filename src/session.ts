import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
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
} from "@yume-chan/scrcpy";
import { HidKeyboard, HidKeyboardDescriptor, UHidKeyboardId } from "./hid-keyboard";
import { mapKeyboardCode } from "./keymap";
import { createScrcpy4MediaStreamTransformer, isScrcpy4Version } from "./scrcpy4";
import type {
  CodecSupport,
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

interface DeviceAppSummary {
  name: string;
  packageName: string;
  system: boolean;
}

function isIpEndpoint(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/.test(value.trim());
}

function toSummary(device: AdbServerClientType.Device): DeviceSummary {
  // model/device/product are often near-duplicates (e.g. BLA_AL00 / HWBLA / BLA-AL00);
  // keep only parts that are distinct after normalizing separators.
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const part of [device.model, device.device, device.product]) {
    if (!part) {
      continue;
    }
    const key = part.toLowerCase().replace(/[-_\s]/g, "");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    parts.push(part);
  }
  const label = parts.join(" / ");
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

const KeepAwakeScreenOffTimeoutMs = 24 * 60 * 60 * 1000;

const StreamSettingKeys = [
  "maxFps",
  "maxSize",
  "videoBitRate",
  "videoCodec",
  "videoBufferMs",
  "rootMode",
  "screenOffOnStart",
  "keepScreenAwake",
  "keepActive",
  "flexDisplay",
  "powerOnOnStart",
  "powerOffOnClose",
  "audioEnabled",
  "audioCodec",
  "adaptiveQuality",
  "uhidKeyboard",
] as const;

// Quality rungs for adaptive downgrade, lowest first. Downgrades reconnect the
// stream, so steps are coarse and only triggered on sustained congestion.
const AdaptiveQualityLadder: ReadonlyArray<
  Pick<StreamConfig, "maxFps" | "maxSize" | "videoBitRate" | "videoBufferMs">
> = [
  { maxFps: 15, maxSize: 800, videoBitRate: 1000000, videoBufferMs: 200 },
  { maxFps: 24, maxSize: 960, videoBitRate: 1800000, videoBufferMs: 150 },
  { maxFps: 30, maxSize: 1080, videoBitRate: 3000000, videoBufferMs: 80 },
  { maxFps: 30, maxSize: 1280, videoBitRate: 6000000, videoBufferMs: 20 },
];

function pickStreamConfig(config: ExtensionConfig): StreamConfig {
  const picked: Partial<StreamConfig> = {};
  for (const key of StreamSettingKeys) {
    (picked as Record<string, unknown>)[key] = config[key];
  }
  return picked as StreamConfig;
}

export class ScrcpySidebarSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly client: AdbServerClient;
  private readonly webview: WebviewLike;
  private config: ExtensionConfig;
  private currentSerial?: string;
  private reconnectTimer?: NodeJS.Timeout;
  private manuallyDisconnected = false;
  private scrcpyClient?: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>;
  private scrcpyAbort = new AbortController();
  private videoLoop?: Promise<void>;
  private currentStreamConfig: StreamConfig;
  private currentRootMode: "auto" | "always" | "never";
  private currentStartAppPackage?: string;
  private currentDeviceName = "";
  private streamSize = { width: 0, height: 0 };
  private videoPacketsSent = 0;
  private isPointerDown = false;
  private readonly rootAvailability = new Map<string, boolean>();
  private activeControlMode: "standard" | "root" = "standard";
  private forcedControlMode?: "standard" | "root";
  private rootUpgradeScheduled = false;
  private lastScrcpyLogs: string[] = [];
  private webviewCodecSupport?: CodecSupport;
  private codecFallbackNote?: string;
  private lastAdaptiveDowngradeAt = 0;
  private connectInFlight = false;
  private pendingConnect?: { serial: string; name: string; forcedMode?: "standard" | "root"; startAppPackage?: string };
  private screenPowerOffPending = false;
  private displayOffEnforceTimer?: NodeJS.Timeout;
  private persistingConfig = false;
  private reconnectingInternally = false;
  private codecFallbackScheduled = false;
  private webviewMessageQueue: ExtensionToWebviewMessage[] = [];
  private webviewMessageDrainRunning = false;
  private queuedVideoMessages = 0;
  private readonly maxQueuedVideoMessages = 24;
  private firstVideoDataPacketReceived = false;
  private miuiAdbInputPromptShown = false;
  private hidKeyboard?: HidKeyboard;
  private lastSyncedClipboardText?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    config: ExtensionConfig,
    webview: WebviewLike,
  ) {
    this.webview = webview;
    this.config = config;
    this.client = new AdbServerClient(
      new AdbServerNodeTcpConnector({
        host: config.adbHost,
        port: config.adbPort,
      }),
    );
    this.currentStreamConfig = pickStreamConfig(config);
    this.currentRootMode = config.rootMode;
  }

  get isPersistingConfig(): boolean {
    return this.persistingConfig;
  }

  async initialize(): Promise<void> {
    await this.syncConfigToWebview();
    await this.syncDeviceScreenState("unknown");
    await this.refreshDevices();
  }

  private async syncConfigToWebview(): Promise<void> {
    await this.post({
      type: "config",
      config: this.currentStreamConfig,
    });
  }

  private async syncDeviceScreenState(state: "on" | "off" | "unknown"): Promise<void> {
    await this.post({
      type: "device-screen",
      state,
    });
  }

  private async syncCurrentDeviceScreenState(
    adb?: Awaited<ReturnType<AdbServerClient["createAdb"]>>,
  ): Promise<"on" | "off" | "unknown"> {
    const serial = this.currentSerial;
    if (!adb && !serial) {
      await this.syncDeviceScreenState("unknown");
      return "unknown";
    }

    const currentAdb = adb ?? await this.client.createAdb({ serial: serial! });
    const state = await this.getDisplayPowerState(currentAdb);
    await this.syncDeviceScreenState(state);
    return state;
  }

  dispose(): void {
    void this.disposeAsync("Session disposed");
  }

  async disposeAsync(detail?: string): Promise<void> {
    await this.stop(detail ?? "Session disposed");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.scrcpyAbort.abort();
    this.pendingConnect = undefined;
    this.webviewMessageQueue = [];
    this.queuedVideoMessages = 0;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  async applyConfig(nextConfig: ExtensionConfig): Promise<boolean> {
    const requiresSessionReset =
      this.config.adbHost !== nextConfig.adbHost ||
      this.config.adbPort !== nextConfig.adbPort ||
      this.config.scrcpyServerVersion !== nextConfig.scrcpyServerVersion;
    const shouldReconnect =
      !requiresSessionReset &&
      this.scrcpyClient !== undefined &&
      StreamSettingKeys.some((key) => this.config[key] !== nextConfig[key]);

    this.config = nextConfig;
    this.currentStreamConfig = pickStreamConfig(nextConfig);
    this.currentRootMode = nextConfig.rootMode;
    void this.syncConfigToWebview();
    if (shouldReconnect) {
      await this.reconnect();
    }

    return requiresSessionReset;
  }

  async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.syncConfigToWebview();
        await this.syncDeviceScreenState("unknown");
        await this.refreshDevices();
        return;
      case "codec-support":
        this.webviewCodecSupport = message.codecs;
        this.output.appendLine(
          `webview codec support: h264=${message.codecs.h264} h265=${message.codecs.h265} av1=${message.codecs.av1}`,
        );
        return;
      case "congestion":
        await this.handleCongestion(message.queuedPackets, message.bufferedMs);
        return;
      case "select-device":
        await this.promptAndConnect();
        return;
      case "disconnect":
        this.manuallyDisconnected = true;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
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
      case "resize-display":
        await this.resizeFlexDisplay(message.width, message.height);
        return;
      case "key":
        await this.injectKey(message.key);
        return;
      case "keyboard-text":
        await this.injectKeyboardText(message.text);
        return;
      case "keyboard-event":
        await this.injectKeyboardEvent(message);
        return;
      case "keyboard-reset":
        this.resetHidKeyboard();
        return;
      case "clipboard-paste":
        await this.pasteFromHostClipboard();
        return;
      case "apply-config":
        await this.persistConfig(message.config);
        return;
      case "pointer":
        void this.injectPointer(message);
        return;
      case "scroll":
        void this.injectScroll(message);
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
      const startAppPackage = await this.pickFlexDisplayApp(selected.device);
      if (startAppPackage === false) {
        return;
      }
      await this.connect(selected.device.serial, selected.device.name, undefined, startAppPackage);
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
      await this.promptAndConnect();
      return;
    }

    const serial = this.currentSerial;
    const name = this.currentDeviceName || serial;
    this.reconnectingInternally = true;
    try {
      await this.stop("Reconnecting");
      await this.connect(serial, name, this.forcedControlMode, this.currentStartAppPackage);
    } finally {
      this.reconnectingInternally = false;
    }
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

  private async pickFlexDisplayApp(device: DeviceSummary): Promise<string | undefined | false> {
    if (!this.currentStreamConfig.flexDisplay || !isScrcpy4Version(this.config.scrcpyServerVersion)) {
      return undefined;
    }

    const apps = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `读取 ${device.name} 的可启动 App`,
      },
      async () => this.listLaunchableApps(device.serial),
    );

    if (apps.length === 0) {
      await vscode.window.showWarningMessage("没有读取到可启动 App，已取消 Flex display 连接。");
      return false;
    }

    type AppPickItem = vscode.QuickPickItem & { app: DeviceAppSummary };
    const selected = await vscode.window.showQuickPick<AppPickItem>(
      apps.map((app) => ({
        label: app.name,
        description: app.packageName,
        detail: app.system ? "系统应用" : "用户应用",
        app,
      })),
      {
        title: "选择要在 Flex display 中启动的 App",
        placeHolder: "Flex display 会创建新的虚拟显示，请选择要打开的 App",
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );

    return selected?.app.packageName ?? false;
  }

  private parseAppList(output: string): DeviceAppSummary[] {
    const apps: DeviceAppSummary[] = [];
    for (const line of output.split(/\r?\n/)) {
      const normalized = line.replace(/^\[server\]\s+\w+:\s*/, "");
      const match = normalized.match(/^\s*([*-])\s+(.+?)\s+([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\s*$/);
      if (!match) {
        continue;
      }

      apps.push({
        system: match[1] === "*",
        name: match[2]!.trim(),
        packageName: match[3]!,
      });
    }
    return apps;
  }

  private async listLaunchableApps(serial: string): Promise<DeviceAppSummary[]> {
    const adb = await this.client.createAdb({ serial });
    const serverPath = await this.pushServerToDevice(adb, serial);
    const output = await adb.subprocess.noneProtocol.spawnWaitText([
      `CLASSPATH=${serverPath}`,
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      this.config.scrcpyServerVersion,
      "log_level=info",
      "list_apps=true",
      "cleanup=false",
    ]);
    const apps = this.parseAppList(output);
    this.output.appendLine(`listed ${apps.length} launchable apps for ${serial}`);
    return apps;
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
      const startAppPackage = await this.pickFlexDisplayApp(match);
      if (startAppPackage === false) {
        return;
      }
      await this.connect(match.serial, match.name, undefined, startAppPackage);
      return;
    }

    await this.post({
      type: "error",
      message: `连接失败: ${result || normalized}`,
    });
  }

  private async connect(
    serial: string,
    name: string,
    forcedMode?: "standard" | "root",
    startAppPackage?: string,
  ): Promise<void> {
    if (this.connectInFlight) {
      this.pendingConnect = { serial, name, forcedMode, startAppPackage };
      this.output.appendLine(`connect queued while another connect is active: ${serial}`);
      return;
    }

    this.connectInFlight = true;
    this.manuallyDisconnected = false;
    this.currentSerial = serial;
    this.currentDeviceName = name;
    this.forcedControlMode = forcedMode;
    this.currentStartAppPackage = startAppPackage;
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
      this.warnIfBundledServerVersionMayDiffer();
      const serverPath = await this.pushServerToDevice(adb, serial);
      const rootAvailable = await this.checkRoot(adb);
      await this.prepareDevicePowerForStreaming(adb);
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
      if (controlMode === "root") {
        void this.ensureMiuiAdbInputEnabled(adb);
      }
      this.scrcpyClient = scrcpyClient;
      this.hidKeyboard = undefined;
      if (this.currentStreamConfig.uhidKeyboard !== false) {
        void this.setupUhidKeyboard(adb, scrcpyClient);
      }
      this.watchDeviceClipboard(scrcpyClient);
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
      await this.syncCurrentDeviceScreenState(adb);
      const metadataWidth = videoStream.metadata.width ?? 0;
      const metadataHeight = videoStream.metadata.height ?? 0;
      this.streamSize = {
        width: videoStream.width || metadataWidth,
        height: videoStream.height || metadataHeight,
      };
      this.videoPacketsSent = 0;
      this.firstVideoDataPacketReceived = false;
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
        detail: this.codecFallbackNote ? `${name} · ${serial} · ${this.codecFallbackNote}` : `${name} · ${serial}`,
        mode: controlMode,
      });

      videoStream.sizeChanged(({ width, height }) => {
        this.streamSize = { width, height };
      });

      const reader = videoStream.stream.getReader();
      const abortSignal = this.scrcpyAbort.signal;
      this.videoLoop = (async () => {
        try {
          while (!abortSignal.aborted) {
            const { done, value } = await reader.read();
            if (done || !value) {
              break;
            }
            const data = value.data;
            if (value.type === "configuration") {
              this.output.appendLine(`video configuration packet received (${data.byteLength} bytes)`);
            }
            if (value.type === "data" && !this.firstVideoDataPacketReceived) {
              this.firstVideoDataPacketReceived = true;
              this.output.appendLine("first video packet received");
            }
            const packet: VideoPacketPayload = {
              type: value.type,
              data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
              keyframe: value.type === "data" ? value.keyframe : undefined,
              pts: value.type === "data" && value.pts !== undefined ? value.pts.toString() : undefined,
            };
            this.videoPacketsSent += 1;
            void this.post({ type: "video", packet });
          }
        } finally {
          reader.releaseLock();
        }
      })();
      void this.startSelectedFlexDisplayApp();
      this.drainAudioStream(scrcpyClient);

      scrcpyClient.exited
        .then(() => {
          if (this.scrcpyClient !== scrcpyClient) {
            return;
          }
          const tail = this.lastScrcpyLogs.at(-1);
          return this.handleDisconnect(tail ? `scrcpy exited · ${tail}` : "scrcpy exited");
        })
        .catch((error) => {
          if (this.scrcpyClient !== scrcpyClient) {
            return;
          }
          return this.handleDisconnect(String(error));
        });
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
      const pending = this.pendingConnect;
      this.pendingConnect = undefined;
      if (pending) {
        await this.connect(pending.serial, pending.name, pending.forcedMode, pending.startAppPackage);
      }
    }
  }

  private async stop(detail?: string): Promise<void> {
    if (this.scrcpyClient) {
      try {
        await this.scrcpyClient.close();
      } catch {
        // ignore
      }
      this.scrcpyClient = undefined;
    }
    this.hidKeyboard = undefined;

    this.scrcpyAbort.abort();
    this.scrcpyAbort = new AbortController();
    this.screenPowerOffPending = false;
    if (this.displayOffEnforceTimer) {
      clearTimeout(this.displayOffEnforceTimer);
      this.displayOffEnforceTimer = undefined;
    }

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
      await this.syncDeviceScreenState("unknown");
    }
  }

  private async handleDisconnect(detail: string): Promise<void> {
    this.output.appendLine(`stream disconnected: ${detail}; packetsSent=${this.videoPacketsSent}`);
    await this.post({ type: "stream-stop", detail });
    await this.post({ type: "state", status: "disconnected", detail, mode: this.activeControlMode });
    await this.syncDeviceScreenState("unknown");
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
        await this.connect(serial, name, this.forcedControlMode, this.currentStartAppPackage);
        return;
      }

      try {
        await this.client.reconnectDevice({ serial });
      } catch (error) {
        this.output.appendLine(`adb reconnect ${serial} failed: ${String(error)}`);
      }
      await sleep(500);
      await this.connect(serial, name, this.forcedControlMode, this.currentStartAppPackage);
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

  private async injectScroll(message: Extract<WebviewToExtensionMessage, { type: "scroll" }>): Promise<void> {
    const controller = this.scrcpyClient?.controller;
    if (!controller) {
      return;
    }

    if (!this.streamSize.width || !this.streamSize.height) {
      return;
    }

    const pointerX = Math.max(0, Math.min(this.streamSize.width, Math.round(message.x)));
    const pointerY = Math.max(0, Math.min(this.streamSize.height, Math.round(message.y)));
    const scrollX = Math.max(-16, Math.min(16, message.scrollX));
    const scrollY = Math.max(-16, Math.min(16, message.scrollY));
    if (Math.abs(scrollX) < 0.001 && Math.abs(scrollY) < 0.001) {
      return;
    }

    try {
      await controller.injectScroll({
        pointerX,
        pointerY,
        videoWidth: this.streamSize.width,
        videoHeight: this.streamSize.height,
        scrollX,
        scrollY,
        buttons: AndroidMotionEventButton.None,
      });
    } catch (error) {
      this.output.appendLine(`injectScroll failed: ${String(error)}`);
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
      if (this.currentStreamConfig.screenOffOnStart) {
        await this.togglePowerKeepingDisplayOff();
        return;
      }

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

  // In screenOffOnStart mode the power button toggles the device between awake and
  // asleep (a normal POWER key press), but the physical display must never light up:
  // force it off right after, on top of the display-on log enforcement.
  private async togglePowerKeepingDisplayOff(): Promise<void> {
    const controller = this.scrcpyClient?.controller;
    const serial = this.currentSerial;
    if (!serial) {
      return;
    }

    this.output.appendLine("toggling device power while keeping physical display blank");
    try {
      if (!controller) {
        throw new Error("scrcpy controller unavailable");
      }
      await controller.injectKeyCode({
        action: AndroidKeyEventAction.Down,
        keyCode: AndroidKeyCode.Power,
        repeat: 0,
        metaState: AndroidKeyEventMeta.None,
      });
      await controller.injectKeyCode({
        action: AndroidKeyEventAction.Up,
        keyCode: AndroidKeyCode.Power,
        repeat: 0,
        metaState: AndroidKeyEventMeta.None,
      });
    } catch (error) {
      this.output.appendLine(`power toggle failed: ${String(error)}`);
      await this.injectKeyViaAdb(serial, "26");
    }

    const currentController = this.scrcpyClient?.controller;
    if (!currentController) {
      return;
    }
    await sleep(300);
    try {
      await currentController.setScreenPowerMode(AndroidScreenPowerMode.Off);
      await this.syncDeviceScreenState("off");
    } catch (error) {
      this.output.appendLine(`forcing display off after power toggle failed: ${String(error)}`);
    }
  }

  // Register a UHID hardware keyboard on the device. With a hardware keyboard
  // present and show_ime_with_hard_keyboard=0, Android keeps the soft IME
  // hidden while typing.
  private async setupUhidKeyboard(
    adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>,
    scrcpyClient: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>,
  ): Promise<void> {
    const controller = scrcpyClient.controller;
    if (!controller) {
      return;
    }

    try {
      await controller.uHidCreate({
        id: UHidKeyboardId,
        vendorId: 0,
        productId: 0,
        name: "scrcpy-sidebar",
        data: HidKeyboardDescriptor,
      });
      if (this.scrcpyClient !== scrcpyClient) {
        return;
      }
      this.hidKeyboard = new HidKeyboard();
      this.output.appendLine("UHID keyboard registered");
    } catch (error) {
      this.output.appendLine(`UHID keyboard create failed, falling back to key injection: ${String(error)}`);
      return;
    }

    try {
      const current = (await this.runDeviceCommand(adb, ["settings", "get", "secure", "show_ime_with_hard_keyboard"])).trim();
      if (current !== "0") {
        await this.runDeviceCommand(adb, ["settings", "put", "secure", "show_ime_with_hard_keyboard", "0"]);
        this.output.appendLine(`disabled soft IME with hardware keyboard (show_ime_with_hard_keyboard ${current} -> 0)`);
      }
    } catch (error) {
      this.output.appendLine(`show_ime_with_hard_keyboard update failed: ${String(error)}`);
    }
  }

  private resetHidKeyboard(): void {
    const controller = this.scrcpyClient?.controller;
    const hid = this.hidKeyboard;
    if (!controller || !hid) {
      return;
    }
    void controller.uHidInput({ id: UHidKeyboardId, data: hid.reset() }).catch((error) => {
      this.output.appendLine(`UHID keyboard reset failed: ${String(error)}`);
    });
  }

  private watchDeviceClipboard(scrcpyClient: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>): void {
    const stream = scrcpyClient.clipboard;
    if (!stream) {
      return;
    }
    void (async () => {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || this.scrcpyClient !== scrcpyClient) {
            break;
          }
          if (value && value !== this.lastSyncedClipboardText) {
            this.lastSyncedClipboardText = value;
            await vscode.env.clipboard.writeText(value);
            this.output.appendLine(`device clipboard -> host (${value.length} chars)`);
          }
        }
      } catch (error) {
        this.output.appendLine(`device clipboard stream ended: ${String(error)}`);
      } finally {
        reader.releaseLock();
      }
    })();
  }

  private async pasteFromHostClipboard(): Promise<void> {
    const controller = this.scrcpyClient?.controller;
    if (!controller) {
      return;
    }
    const text = await vscode.env.clipboard.readText();
    if (!text) {
      return;
    }
    this.lastSyncedClipboardText = text;
    try {
      await controller.setClipboard({ sequence: 0n, paste: true, content: text });
    } catch (error) {
      this.output.appendLine(`setClipboard failed, typing text instead: ${String(error)}`);
      await this.injectKeyboardText(text);
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

  private async injectKeyboardEvent(
    message: Extract<WebviewToExtensionMessage, { type: "keyboard-event" }>,
  ): Promise<void> {
    const controller = this.scrcpyClient?.controller;
    const serial = this.currentSerial;
    if (!serial || (message.repeat && message.action !== "down")) {
      return;
    }

    const hid = this.hidKeyboard;
    if (hid && controller) {
      // A UHID keyboard repeats keys on the device side while held.
      if (message.repeat) {
        return;
      }
      const report = hid.handleKey(message.code, message.action);
      if (report) {
        try {
          await controller.uHidInput({ id: UHidKeyboardId, data: report });
          return;
        } catch (error) {
          this.output.appendLine(`UHID input failed (${message.code}), falling back to key injection: ${String(error)}`);
          this.hidKeyboard = undefined;
        }
      }
    }

    const metaState = ((
      (message.altKey ? AndroidKeyEventMeta.Alt : 0) |
      (message.shiftKey ? AndroidKeyEventMeta.Shift : 0) |
      (message.ctrlKey ? AndroidKeyEventMeta.Ctrl : 0) |
      (message.metaKey ? AndroidKeyEventMeta.Meta : 0)
    ) as AndroidKeyEventMeta);

    const target = mapKeyboardCode(message.code, message.key);
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
        repeat: message.repeat ? 1 : 0,
        metaState,
      });
    } catch (error) {
      this.output.appendLine(`injectKeyboardEvent failed (${message.code}/${message.key}): ${String(error)}`);
      if (message.action === "down") {
        await this.injectKeyViaAdb(serial, target.adb);
      }
    }
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

  private warnIfBundledServerVersionMayDiffer(): void {
    const packageVersion = this.context.extension.packageJSON?.contributes?.configuration?.properties?.["scrcpySidebar.scrcpyServerVersion"]?.default;
    if (typeof packageVersion === "string" && packageVersion !== this.config.scrcpyServerVersion) {
      this.output.appendLine(
        `scrcpyServerVersion is ${this.config.scrcpyServerVersion}, but the bundled scrcpy-server.bin was installed for ${packageVersion}`,
      );
    }
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

  // Browser-side audio playback is not implemented yet. The audio socket must still be
  // consumed, otherwise ADB flow control back-pressures the server's audio thread.
  private drainAudioStream(scrcpyClient: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>): void {
    const audioStream = scrcpyClient.audioStream;
    if (!audioStream) {
      return;
    }

    void (async () => {
      try {
        const metadata = await audioStream;
        if (metadata.type !== "success") {
          this.output.appendLine(`audio stream unavailable on device: ${metadata.type}`);
          return;
        }
        this.output.appendLine("audio stream opened (playback not implemented, draining)");
        const reader = metadata.stream.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) {
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (error) {
        this.output.appendLine(`audio stream error: ${String(error)}`);
      }
    })();
  }

  private async startSelectedFlexDisplayApp(): Promise<void> {
    if (!this.currentStreamConfig.flexDisplay || !this.currentStartAppPackage) {
      return;
    }

    const controller = this.scrcpyClient?.controller;
    if (!controller) {
      return;
    }

    try {
      this.output.appendLine(`starting selected app on flex display: ${this.currentStartAppPackage}`);
      await controller.startApp(this.currentStartAppPackage);
    } catch (error) {
      this.output.appendLine(`failed to start selected app on flex display: ${String(error)}`);
    }
  }

  private async getDisplayPowerState(
    adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>,
  ): Promise<"on" | "off" | "unknown"> {
    try {
      const output = await this.runDeviceCommand(adb, ["dumpsys", "display"]);
      // Field name and casing vary across Android versions/ROMs.
      const match =
        output.match(/Display State=(ON|OFF)/i) ??
        output.match(/mScreenState=(ON|OFF)/i) ??
        output.match(/Display Power: state=(ON|OFF)/i);
      if (match) {
        return match[1]!.toUpperCase() === "ON" ? "on" : "off";
      }
    } catch (error) {
      this.output.appendLine(`getDisplayPowerState failed: ${String(error)}`);
    }

    return "unknown";
  }

  private async prepareDevicePowerForStreaming(
    adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>,
  ): Promise<void> {
    if (this.currentStreamConfig.powerOnOnStart) {
      return;
    }

    // Wake whenever the display is off (regardless of screenOffOnStart): some ROMs return a
    // black capture if scrcpy starts while the physical screen is off. With screenOffOnStart
    // the post-first-frame power-off turns it back off; without it the screen simply stays on.
    // During internal reconnects dumpsys may still report ON while the old server's forced-off
    // is being cleaned up, so wake unconditionally there.
    const displayState = await this.getDisplayPowerState(adb);
    if (displayState !== "off" && !this.reconnectingInternally) {
      return;
    }
    this.output.appendLine("waking device briefly so capture can start");
    try {
      await this.runDeviceCommand(adb, ["input", "keyevent", "KEYCODE_WAKEUP"]);
      await sleep(this.reconnectingInternally ? 1200 : 500);
    } catch (error) {
      this.output.appendLine(`temporary wake failed: ${String(error)}`);
    }
  }

  private async applyPendingScreenPowerOff(): Promise<void> {
    if (!this.screenPowerOffPending) {
      return;
    }

    await this.requestDeviceScreenOffViaController("webview video ready");
  }

  private async requestDeviceScreenOffViaController(reason: string): Promise<void> {
    if (!this.currentStreamConfig.screenOffOnStart || !this.screenPowerOffPending) {
      return;
    }

    const controller = this.scrcpyClient?.controller;
    if (!controller) {
      return;
    }

    this.screenPowerOffPending = false;
    this.output.appendLine(`requesting display power off via scrcpy controller (${reason})`);
    try {
      await controller.setScreenPowerMode(AndroidScreenPowerMode.Off);
      await this.syncDeviceScreenState("off");
    } catch (error) {
      this.output.appendLine(`setScreenPowerMode failed: ${String(error)}`);
      await this.syncDeviceScreenState("unknown");
    }
  }

  // With screenOffOnStart the physical display must stay dark no matter what wakes it
  // (touch input, notifications, the power toggle): whenever scrcpy reports the display
  // turning on, force it back off shortly after.
  private scheduleDisplayOffEnforcement(): void {
    if (!this.currentStreamConfig.screenOffOnStart || this.screenPowerOffPending || this.displayOffEnforceTimer) {
      return;
    }

    const scrcpyClient = this.scrcpyClient;
    const controller = scrcpyClient?.controller;
    if (!scrcpyClient || !controller) {
      return;
    }

    this.displayOffEnforceTimer = setTimeout(() => {
      this.displayOffEnforceTimer = undefined;
      if (this.scrcpyClient !== scrcpyClient || !this.currentStreamConfig.screenOffOnStart) {
        return;
      }

      this.output.appendLine("display woke up, forcing it back off");
      void controller.setScreenPowerMode(AndroidScreenPowerMode.Off)
        .then(() => this.syncDeviceScreenState("off"))
        .catch((error) => {
          this.output.appendLine(`forcing display off failed: ${String(error)}`);
        });
    }, 250);
  }

  private handleScrcpyLogLine(line: string): void {
    if (line.includes("Device display turned off")) {
      void this.syncDeviceScreenState("off");
    } else if (line.includes("Device display turned on")) {
      void this.syncDeviceScreenState("on");
      this.scheduleDisplayOffEnforcement();
    }

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
      await this.connect(serial, name, "root", this.currentStartAppPackage);
    } finally {
      this.rootUpgradeScheduled = false;
    }
  }

  private async handleCongestion(queuedPackets: number, bufferedMs: number): Promise<void> {
    if (!this.currentStreamConfig.adaptiveQuality || !this.scrcpyClient || this.connectInFlight) {
      return;
    }
    const now = Date.now();
    if (now - this.lastAdaptiveDowngradeAt < 20000) {
      return;
    }

    const currentBitRate = this.currentStreamConfig.videoBitRate;
    let nextRung: (typeof AdaptiveQualityLadder)[number] | undefined;
    for (let i = AdaptiveQualityLadder.length - 1; i >= 0; i -= 1) {
      if (AdaptiveQualityLadder[i]!.videoBitRate < currentBitRate) {
        nextRung = AdaptiveQualityLadder[i];
        break;
      }
    }
    if (!nextRung) {
      this.output.appendLine(
        `congestion reported (queue=${queuedPackets}, buffered=${bufferedMs}ms) but already at lowest quality rung`,
      );
      return;
    }

    this.lastAdaptiveDowngradeAt = now;
    const summary = `${nextRung.maxSize}px@${nextRung.maxFps} · ${(nextRung.videoBitRate / 1000000).toFixed(1)}Mbps`;
    this.output.appendLine(
      `congestion detected (queue=${queuedPackets}, buffered=${bufferedMs}ms), downgrading stream to ${summary}`,
    );
    this.currentStreamConfig = { ...this.currentStreamConfig, ...nextRung };
    await this.post({
      type: "state",
      status: "reconnecting",
      detail: `网络拥塞，已自动降级到 ${summary}`,
      mode: this.activeControlMode,
    });
    await this.reconnect();
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

  // MIUI revokes shell's INJECT_EVENTS unless "USB debugging (Security settings)" is enabled.
  // The toggle is backed by persist.security.adbinput; setting it via root avoids the
  // SIM + Mi account requirement of the UI switch. Takes effect after a device reboot,
  // after which standard (non-root) control works.
  private async ensureMiuiAdbInputEnabled(
    adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>,
  ): Promise<void> {
    try {
      const miuiVersion = (await adb.subprocess.noneProtocol.spawnWaitText(["getprop", "ro.miui.ui.version.name"])).trim();
      if (!miuiVersion) {
        return;
      }

      const current = (await adb.subprocess.noneProtocol.spawnWaitText(["getprop", "persist.security.adbinput"])).trim();
      if (current === "1") {
        return;
      }

      await this.runDeviceCommand(adb, ["setprop", "persist.security.adbinput", "1"], true);
      const applied = (await adb.subprocess.noneProtocol.spawnWaitText(["getprop", "persist.security.adbinput"])).trim();
      if (applied !== "1") {
        this.output.appendLine("failed to enable persist.security.adbinput via root");
        return;
      }

      this.output.appendLine("enabled MIUI USB debugging (Security settings) via persist.security.adbinput=1");
      if (this.miuiAdbInputPromptShown) {
        return;
      }
      this.miuiAdbInputPromptShown = true;
      const serial = this.currentSerial;
      void vscode.window
        .showInformationMessage(
          "已自动开启 MIUI「USB 调试（安全设置）」，重启手机后无需 Root 即可控制。",
          "立即重启设备",
        )
        .then((choice) => {
          if (choice === "立即重启设备" && serial) {
            this.output.appendLine(`rebooting ${serial} to apply persist.security.adbinput`);
            execFile("adb", ["-s", serial, "reboot"]);
          }
        });
    } catch (error) {
      this.output.appendLine(`ensureMiuiAdbInputEnabled failed: ${String(error)}`);
    }
  }

  private async checkRoot(adb: Awaited<ReturnType<AdbServerClient["createAdb"]>>): Promise<boolean> {
    const serial = this.currentSerial;
    if (serial && this.rootAvailability.has(serial)) {
      return this.rootAvailability.get(serial)!;
    }

    let rootAvailable = false;
    try {
      const result = await adb.subprocess.noneProtocol.spawnWaitText(["su", "-c", "id"]);
      rootAvailable = result.includes("uid=0");
    } catch {
      rootAvailable = false;
    }

    if (serial) {
      this.rootAvailability.set(serial, rootAvailable);
    }
    this.output.appendLine(`root available (${serial ?? "unknown"}): ${rootAvailable}`);
    return rootAvailable;
  }

  // Prefer the configured codec, but drop to h264 when the webview reported it
  // cannot decode it. Keeps the user's preference intact for environments that can.
  private resolveVideoCodec(): "h264" | "h265" | "av1" {
    const preferred = this.currentStreamConfig.videoCodec;
    const support = this.webviewCodecSupport;
    this.codecFallbackNote = undefined;
    if (preferred === "h264" || !support || support[preferred]) {
      return preferred;
    }
    this.codecFallbackNote = `${preferred === "h265" ? "H.265" : "AV1"} 不受当前环境支持，已回退 H.264`;
    this.output.appendLine(`webview cannot decode ${preferred}, starting stream with h264 instead`);
    return "h264";
  }

  private createOptions(spawner: AdbNoneProtocolSpawner | undefined): AdbScrcpyOptionsLatest<true> {
    const isScrcpy4 = isScrcpy4Version(this.config.scrcpyServerVersion);
    const options = new AdbScrcpyOptionsLatest({
      scid: ScrcpyInstanceId.random(),
      video: true,
      audio: !!this.currentStreamConfig.audioEnabled,
      audioCodec: this.currentStreamConfig.audioCodec ?? "aac",
      control: true,
      cleanup: true,
      // 必须走 forward tunnel。reverse 模式下 AdbServerNodeTcpConnector 在本机开
      // TCP 监听并让 adb server 把设备连接转发到 tcp:PORT——当 adb server 在远端
      // (ANDROID_ADB_SERVER_ADDRESS)时它连的是 adb server 那台机器的 localhost，
      // 连接被拒导致 scrcpy server 立即退出，残留的 reverse 还会挂死设备 transport。
      tunnelForward: true,
      powerOn: !!this.currentStreamConfig.powerOnOnStart,
      powerOffOnClose: !!this.currentStreamConfig.powerOffOnClose && !this.reconnectingInternally,
      stayAwake: !!this.currentStreamConfig.keepScreenAwake,
      screenOffTimeout: this.currentStreamConfig.keepScreenAwake ? KeepAwakeScreenOffTimeoutMs : undefined,
      maxFps: this.currentStreamConfig.maxFps,
      maxSize: this.currentStreamConfig.maxSize,
      videoBitRate: this.currentStreamConfig.videoBitRate,
      videoCodec: this.resolveVideoCodec(),
      sendCodecMeta: !isScrcpy4,
      sendDeviceMeta: true,
    }, {
      version: this.config.scrcpyServerVersion,
      spawner,
    });

    if (isScrcpy4) {
      const serialize = options.serialize.bind(options);
      options.createMediaStreamTransformer = createScrcpy4MediaStreamTransformer;
      options.serialize = () => [
        ...serialize().filter((arg) => !arg.startsWith("send_codec_meta=")),
        "send_stream_meta=false",
        ...(this.currentStreamConfig.keepActive ? ["keep_active=true"] : []),
        ...(this.currentStreamConfig.flexDisplay ? ["new_display=", "flex_display=true"] : []),
      ];
    }

    return options;
  }

  private async resizeFlexDisplay(width: number, height: number): Promise<void> {
    if (!this.currentStreamConfig.flexDisplay || !isScrcpy4Version(this.config.scrcpyServerVersion)) {
      return;
    }

    const controller = this.scrcpyClient?.controller;
    if (!controller) {
      return;
    }

    const nextWidth = Math.max(1, Math.min(65535, Math.floor(width)));
    const nextHeight = Math.max(1, Math.min(65535, Math.floor(height)));
    const message = new Uint8Array(5);
    message[0] = 21;
    message[1] = nextWidth >> 8;
    message[2] = nextWidth & 0xff;
    message[3] = nextHeight >> 8;
    message[4] = nextHeight & 0xff;
    await controller.write(message);
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
    let attempted = false;

    for (const mode of tryModes) {
      if (mode === "root" && !(await this.checkRoot(adb))) {
        lastError = new Error("SU/root is not available on this device");
        continue;
      }
      attempted = true;

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
        if (mode === "root" && this.isRootUnavailableError(error)) {
          this.rootAvailability.delete(this.currentSerial ?? "");
        }
        if (mode === "standard" && fallbackMode === "root" && this.shouldRetryWithRoot(error)) {
          this.output.appendLine("falling back to root mode because input injection was denied");
          continue;
        }
        throw error;
      }
    }

    if (!attempted && preferredMode === "root") {
      await this.post({
        type: "state",
        status: "connecting",
        detail: "SU 不可用，回退到标准模式",
        mode: "standard",
      });
      const scrcpyClient = await AdbScrcpyClient.start(adb, serverPath, this.createOptions(undefined));
      return { scrcpyClient, controlMode: "standard" };
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async post(message: ExtensionToWebviewMessage): Promise<void> {
    if (message.type === "video") {
      // Dropping any delta frame corrupts decoding until the next keyframe, so an
      // overflowing queue may only be trimmed when a keyframe arrives: it resets
      // the decoder references, making every older data packet safe to skip.
      if (
        this.queuedVideoMessages >= this.maxQueuedVideoMessages &&
        message.packet.type === "data" &&
        message.packet.keyframe
      ) {
        this.dropQueuedVideoDataFrames();
      }
      this.queuedVideoMessages += 1;
    }

    this.webviewMessageQueue.push(message);
    if (!this.webviewMessageDrainRunning) {
      this.webviewMessageDrainRunning = true;
      while (this.webviewMessageQueue.length) {
        const next = this.webviewMessageQueue.shift();
        if (!next) {
          continue;
        }
        if (next.type === "video") {
          this.queuedVideoMessages = Math.max(0, this.queuedVideoMessages - 1);
        }
        try {
          await this.webview.postMessage(next);
        } catch (error) {
          this.output.appendLine(`webview post failed: ${String(error)}`);
        }
      }
      this.webviewMessageDrainRunning = false;
    }
  }

  private dropQueuedVideoDataFrames(): void {
    let dropped = 0;
    for (let i = this.webviewMessageQueue.length - 1; i >= 0; i -= 1) {
      const item = this.webviewMessageQueue[i];
      if (item?.type === "video" && item.packet.type === "data") {
        this.webviewMessageQueue.splice(i, 1);
        this.queuedVideoMessages = Math.max(0, this.queuedVideoMessages - 1);
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.output.appendLine(`webview post queue congested; skipped ${dropped} stale frames at keyframe boundary`);
    }
  }

  private isRootUnavailableError(error: unknown): boolean {
    const text = String(error);
    return /\bsu\b.*(not found|inaccessible|no such file)/i.test(text) || /permission denied/i.test(text);
  }

  // Writes all keys while configuration-change events are suppressed, then applies the
  // merged config once; per-key change events would otherwise trigger one reconnect each.
  private async persistConfig(config: Partial<StreamConfig>): Promise<void> {
    const settings = vscode.workspace.getConfiguration("scrcpySidebar");
    const entries = (Object.entries(config) as Array<[keyof StreamConfig, StreamConfig[keyof StreamConfig]]>)
      .filter(([, value]) => value !== undefined);

    this.persistingConfig = true;
    try {
      for (const [key, value] of entries) {
        await settings.update(key, value, vscode.ConfigurationTarget.Global);
      }
    } finally {
      this.persistingConfig = false;
    }

    const nextConfig = { ...this.config, ...Object.fromEntries(entries) } as ExtensionConfig;
    await this.applyConfig(nextConfig);
  }
}
