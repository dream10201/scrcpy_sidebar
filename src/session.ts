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
  type ScrcpyMediaStreamPacket,
} from "@yume-chan/scrcpy";
import { TransformStream } from "@yume-chan/stream-extra";
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

interface DeviceAppSummary {
  name: string;
  packageName: string;
  system: boolean;
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

const KeepAwakeScreenOffTimeoutMs = 24 * 60 * 60 * 1000;
const Scrcpy4PacketFlagSession = 1n << 63n;
const Scrcpy4PacketFlagConfig = 1n << 62n;
const Scrcpy4PacketFlagKeyFrame = 1n << 61n;

function createScrcpy4MediaStreamTransformer(): TransformStream<Uint8Array, ScrcpyMediaStreamPacket> {
  let pending = new Uint8Array(0);

  return new TransformStream<Uint8Array, ScrcpyMediaStreamPacket>({
    transform(chunk, controller) {
      if (pending.length) {
        const merged = new Uint8Array(pending.length + chunk.length);
        merged.set(pending, 0);
        merged.set(chunk, pending.length);
        pending = merged;
      } else {
        pending = new Uint8Array(chunk);
      }

      while (pending.length >= 12) {
        const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
        const ptsAndFlags = view.getBigUint64(0);
        const packetSize = view.getUint32(8);
        const frameEnd = 12 + packetSize;
        if (pending.length < frameEnd) {
          return;
        }

        const data = pending.slice(12, frameEnd);
        pending = pending.slice(frameEnd);

        if (ptsAndFlags & Scrcpy4PacketFlagSession) {
          continue;
        }

        if (ptsAndFlags & Scrcpy4PacketFlagConfig) {
          controller.enqueue({ type: "configuration", data });
          continue;
        }

        controller.enqueue({
          type: "data",
          data,
          keyframe: !!(ptsAndFlags & Scrcpy4PacketFlagKeyFrame),
          pts: ptsAndFlags & ~(Scrcpy4PacketFlagSession | Scrcpy4PacketFlagConfig | Scrcpy4PacketFlagKeyFrame),
        });
      }
    },
  });
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
  private connectInFlight = false;
  private pendingConnect?: { serial: string; name: string; forcedMode?: "standard" | "root"; startAppPackage?: string };
  private screenPowerOffPending = false;
  private screenPowerOffTimer?: NodeJS.Timeout;
  private reconnectingInternally = false;
  private codecFallbackScheduled = false;
  private webviewMessageQueue: ExtensionToWebviewMessage[] = [];
  private webviewMessageDrainRunning = false;
  private queuedVideoMessages = 0;
  private readonly maxQueuedVideoMessages = 24;
  private edgeSwipeInProgress = false;
  private firstVideoDataPacketReceived = false;

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
    this.currentStreamConfig = {
      maxFps: config.maxFps,
      maxSize: config.maxSize,
      videoBitRate: config.videoBitRate,
      videoCodec: config.videoCodec,
      videoBufferMs: config.videoBufferMs,
      screenOffOnStart: config.screenOffOnStart,
      keepScreenAwake: config.keepScreenAwake,
      keepActive: config.keepActive,
      flexDisplay: config.flexDisplay,
      powerOnOnStart: config.powerOnOnStart,
      powerOffOnClose: config.powerOffOnClose,
      audioEnabled: config.audioEnabled,
      audioCodec: config.audioCodec,
    };
    this.currentRootMode = config.rootMode;
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
      (
        this.config.maxFps !== nextConfig.maxFps ||
        this.config.maxSize !== nextConfig.maxSize ||
        this.config.videoBitRate !== nextConfig.videoBitRate ||
        this.config.videoCodec !== nextConfig.videoCodec ||
        this.config.videoBufferMs !== nextConfig.videoBufferMs ||
        this.config.rootMode !== nextConfig.rootMode ||
        this.config.screenOffOnStart !== nextConfig.screenOffOnStart ||
        this.config.keepScreenAwake !== nextConfig.keepScreenAwake ||
        this.config.keepActive !== nextConfig.keepActive ||
        this.config.flexDisplay !== nextConfig.flexDisplay ||
        this.config.powerOnOnStart !== nextConfig.powerOnOnStart ||
        this.config.powerOffOnClose !== nextConfig.powerOffOnClose ||
        this.config.audioEnabled !== nextConfig.audioEnabled ||
        this.config.audioCodec !== nextConfig.audioCodec
      );

    this.config = nextConfig;
    this.currentStreamConfig = {
      ...this.currentStreamConfig,
      maxFps: nextConfig.maxFps,
      maxSize: nextConfig.maxSize,
      videoBitRate: nextConfig.videoBitRate,
      videoCodec: nextConfig.videoCodec,
      videoBufferMs: nextConfig.videoBufferMs,
      screenOffOnStart: nextConfig.screenOffOnStart,
      keepScreenAwake: nextConfig.keepScreenAwake,
      keepActive: nextConfig.keepActive,
      flexDisplay: nextConfig.flexDisplay,
      powerOnOnStart: nextConfig.powerOnOnStart,
      powerOffOnClose: nextConfig.powerOffOnClose,
      audioEnabled: nextConfig.audioEnabled,
      audioCodec: nextConfig.audioCodec,
      rootMode: nextConfig.rootMode,
    };
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
      case "keyboard-key":
        await this.injectKeyboardKey(message.key);
        return;
      case "keyboard-event":
        await this.injectKeyboardEvent(message);
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
      case "edge-swipe-back":
        await this.injectEdgeSwipeBack(message);
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
      await this.refreshDevices();
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
    if (!this.currentStreamConfig.flexDisplay || !/^4(?:\.|$)/.test(this.config.scrcpyServerVersion)) {
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
        detail: `${name} · ${serial}`,
        mode: controlMode,
      });

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
      void this.requestDeviceScreenOffViaController("stream setup complete");

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

    this.scrcpyAbort.abort();
    this.scrcpyAbort = new AbortController();
    this.screenPowerOffPending = false;
    if (this.screenPowerOffTimer) {
      clearTimeout(this.screenPowerOffTimer);
      this.screenPowerOffTimer = undefined;
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

  private async injectEdgeSwipeBack(message: Extract<WebviewToExtensionMessage, { type: "edge-swipe-back" }>): Promise<void> {
    const controller = this.scrcpyClient?.controller;
    if (!controller || this.edgeSwipeInProgress || this.isPointerDown) {
      return;
    }

    if (!this.streamSize.width || !this.streamSize.height) {
      return;
    }

    const startX = 1;
    const y = Math.max(1, Math.min(this.streamSize.height - 1, Math.round(message.y)));
    const endX = Math.max(260, Math.min(520, Math.round(this.streamSize.width * 0.42)));
    const steps = 14;

    this.edgeSwipeInProgress = true;
    try {
      await controller.injectTouch({
        action: AndroidMotionEventAction.Down,
        pointerId: ScrcpyPointerId.Finger,
        pointerX: startX,
        pointerY: y,
        videoWidth: this.streamSize.width,
        videoHeight: this.streamSize.height,
        pressure: 1,
        actionButton: AndroidMotionEventButton.None,
        buttons: AndroidMotionEventButton.None,
      });

      for (let step = 1; step <= steps; step += 1) {
        await sleep(14);
        await controller.injectTouch({
          action: AndroidMotionEventAction.Move,
          pointerId: ScrcpyPointerId.Finger,
          pointerX: Math.round(startX + ((endX - startX) * step) / steps),
          pointerY: y,
          videoWidth: this.streamSize.width,
          videoHeight: this.streamSize.height,
          pressure: 1,
          actionButton: AndroidMotionEventButton.None,
          buttons: AndroidMotionEventButton.None,
        });
      }

      await sleep(20);
      await controller.injectTouch({
        action: AndroidMotionEventAction.Up,
        pointerId: ScrcpyPointerId.Finger,
        pointerX: endX,
        pointerY: y,
        videoWidth: this.streamSize.width,
        videoHeight: this.streamSize.height,
        pressure: 0,
        actionButton: AndroidMotionEventButton.None,
        buttons: AndroidMotionEventButton.None,
      });
    } catch (error) {
      this.output.appendLine(`injectEdgeSwipeBack failed: ${String(error)}`);
    } finally {
      this.edgeSwipeInProgress = false;
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
        await this.restoreRemoteScreenWithoutLeavingDeviceOn();
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

  private async restoreRemoteScreenWithoutLeavingDeviceOn(): Promise<void> {
    const controller = this.scrcpyClient?.controller;
    const serial = this.currentSerial;
    if (!serial) {
      return;
    }

    if (!controller) {
      await this.injectKeyViaAdb(serial, "224");
      return;
    }

    this.output.appendLine("restoring remote screen while keeping physical display blank");
    try {
      await controller.backOrScreenOn(AndroidKeyEventAction.Down);
      await sleep(260);
      await controller.setScreenPowerMode(AndroidScreenPowerMode.Off);
      await this.syncDeviceScreenState("off");
    } catch (error) {
      this.output.appendLine(`restore remote screen failed: ${String(error)}`);
      try {
        await this.injectKeyViaAdb(serial, "224");
        await sleep(260);
        await controller.setScreenPowerMode(AndroidScreenPowerMode.Off);
        await this.syncDeviceScreenState("off");
      } catch (fallbackError) {
        this.output.appendLine(`restore remote screen fallback failed: ${String(fallbackError)}`);
        await this.syncDeviceScreenState("unknown");
      }
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
      const match = output.match(/Display State=(ON|OFF)/);
      if (match) {
        return match[1] === "ON" ? "on" : "off";
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

    if (!this.currentStreamConfig.screenOffOnStart) {
      return;
    }

    const displayState = await this.getDisplayPowerState(adb);
    if (displayState !== "off" && !this.reconnectingInternally) {
      return;
    }

    // Some ROMs return a black capture if scrcpy starts while the physical screen is already off.
    // Wake the device briefly, then let the post-first-frame power-off path turn it back off.
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

    const scrcpyClient = this.scrcpyClient;
    const controller = scrcpyClient?.controller;
    if (!scrcpyClient || !controller) {
      return;
    }

    if (this.screenPowerOffTimer) {
      return;
    }

    this.output.appendLine(`requesting display power off via scrcpy controller (${reason})`);
    this.screenPowerOffTimer = setTimeout(() => {
      this.screenPowerOffTimer = undefined;
      if (!this.screenPowerOffPending || this.scrcpyClient !== scrcpyClient) {
        return;
      }

      this.screenPowerOffPending = false;
      void controller.setScreenPowerMode(AndroidScreenPowerMode.Off)
        .then(async () => {
          this.output.appendLine("screen off command sent via scrcpy controller");
          await this.syncDeviceScreenState("off");
        })
        .catch((error) => {
          this.output.appendLine(`setScreenPowerMode failed: ${String(error)}`);
          void this.syncDeviceScreenState("unknown");
        });
    }, 0);
  }

  private handleScrcpyLogLine(line: string): void {
    if (line.includes("Device display turned off")) {
      void this.syncDeviceScreenState("off");
    } else if (line.includes("Device display turned on")) {
      void this.syncDeviceScreenState("on");
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

  private createOptions(spawner: AdbNoneProtocolSpawner | undefined): AdbScrcpyOptionsLatest<true> {
    const isScrcpy4 = /^4(?:\.|$)/.test(this.config.scrcpyServerVersion);
    const options = new AdbScrcpyOptionsLatest({
      scid: ScrcpyInstanceId.random(),
      video: true,
      audio: !!this.currentStreamConfig.audioEnabled,
      audioCodec: this.currentStreamConfig.audioCodec ?? "aac",
      control: true,
      cleanup: true,
      powerOn: !!this.currentStreamConfig.powerOnOnStart,
      powerOffOnClose: !!this.currentStreamConfig.powerOffOnClose && !this.reconnectingInternally,
      stayAwake: !!this.currentStreamConfig.keepScreenAwake,
      screenOffTimeout: this.currentStreamConfig.keepScreenAwake ? KeepAwakeScreenOffTimeoutMs : undefined,
      maxFps: this.currentStreamConfig.maxFps,
      maxSize: this.currentStreamConfig.maxSize,
      videoBitRate: this.currentStreamConfig.videoBitRate,
      videoCodec: this.currentStreamConfig.videoCodec,
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
    if (!this.currentStreamConfig.flexDisplay || !/^4(?:\.|$)/.test(this.config.scrcpyServerVersion)) {
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
      if (this.queuedVideoMessages >= this.maxQueuedVideoMessages) {
        if (message.packet.type === "data" && !message.packet.keyframe) {
          return;
        }
        this.dropOldestQueuedDeltaFrame();
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

  private dropOldestQueuedDeltaFrame(): void {
    const index = this.webviewMessageQueue.findIndex((item) =>
      item.type === "video" && item.packet.type === "data" && !item.packet.keyframe,
    );
    if (index >= 0) {
      this.webviewMessageQueue.splice(index, 1);
      this.queuedVideoMessages = Math.max(0, this.queuedVideoMessages - 1);
    }
  }

  private isRootUnavailableError(error: unknown): boolean {
    const text = String(error);
    return text.includes("su") || text.includes("not found") || text.includes("permission denied");
  }

  private async persistConfig(config: Partial<StreamConfig>): Promise<void> {
    const settings = vscode.workspace.getConfiguration("scrcpySidebar");
    const entries = Object.entries(config) as Array<[keyof StreamConfig, StreamConfig[keyof StreamConfig]]>;
    for (const [key, value] of entries) {
      if (value === undefined) {
        continue;
      }
      await settings.update(key, value, vscode.ConfigurationTarget.Global);
    }
  }
}
