export interface ExtensionConfig {
  adbHost: string;
  adbPort: number;
  maxFps: number;
  maxSize: number;
  videoBitRate: number;
  videoCodec: "h264" | "h265" | "av1";
  autoReconnectDelayMs: number;
  scrcpyServerVersion: string;
  rootMode: "auto" | "always" | "never";
  screenOffOnStart: boolean;
  keepScreenAwake: boolean;
  audioEnabled: boolean;
  audioCodec: "opus" | "aac";
}

export interface DeviceSummary {
  serial: string;
  state: string;
  name: string;
  transportId: string;
}

export interface StreamConfig {
  maxFps: number;
  maxSize: number;
  videoBitRate: number;
  videoCodec: "h264" | "h265" | "av1";
  rootMode?: "auto" | "always" | "never";
  screenOffOnStart?: boolean;
  keepScreenAwake?: boolean;
  audioEnabled?: boolean;
  audioCodec?: "opus" | "aac";
}

export interface StreamStartPayload {
  serial: string;
  deviceName: string;
  width: number;
  height: number;
  codecId: number;
  config: StreamConfig;
  controlMode: "standard" | "root";
}

export interface VideoPacketPayload {
  type: "configuration" | "data";
  data: ArrayBufferLike;
  keyframe?: boolean;
  pts?: string;
}

export type ExtensionToWebviewMessage =
  | { type: "state"; status: string; detail?: string; mode?: "standard" | "root" | "pending" | "view-only" }
  | { type: "devices"; devices: DeviceSummary[]; currentSerial?: string }
  | { type: "stream-start"; payload: StreamStartPayload }
  | { type: "stream-stop"; detail?: string }
  | { type: "video"; packet: VideoPacketPayload }
  | { type: "metrics"; fps: number; renderedFrames: number; skippedFrames: number }
  | { type: "error"; message: string };

export type PointerPhase = "down" | "move" | "up";

export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "select-device" }
  | { type: "disconnect" }
  | { type: "reconnect" }
  | { type: "video-ready" }
  | { type: "decoder-error"; detail: string }
  | { type: "key"; key: "back" | "home" | "appSwitch" | "power" }
  | { type: "apply-config"; config: Partial<StreamConfig> }
  | {
      type: "pointer";
      phase: PointerPhase;
      pointerId: number;
      x: number;
      y: number;
      width: number;
      height: number;
      pressure: number;
      buttons: number;
    };
