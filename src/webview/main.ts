import {
  WebCodecsVideoDecoder,
  BitmapVideoFrameRenderer,
  WebGLVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";
import type { ScrcpyMediaStreamPacket, ScrcpyVideoCodecId } from "@yume-chan/scrcpy";
import type {
  ExtensionToWebviewMessage,
  StreamStartPayload,
  VideoPacketPayload,
  WebviewToExtensionMessage,
} from "../types";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToExtensionMessage): void;
};

const vscode = acquireVsCodeApi();

const deviceLabel = document.querySelector<HTMLSpanElement>("#deviceLabel")!;
const deviceSub = document.querySelector<HTMLSpanElement>("#deviceSub")!;
const statusText = document.querySelector<HTMLDivElement>("#statusText")!;
const overlay = document.querySelector<HTMLDivElement>("#overlay")!;
const metrics = document.querySelector<HTMLSpanElement>("#metrics")!;
const detail = document.querySelector<HTMLSpanElement>("#detail")!;
const statusBadge = document.querySelector<HTMLSpanElement>("#statusBadge")!;
const modeBadge = document.querySelector<HTMLSpanElement>("#modeBadge")!;
const screenStateBadge = document.querySelector<HTMLSpanElement>("#screenStateBadge")!;
const connectBtn = document.querySelector<HTMLButtonElement>("#connectBtn")!;
const canvas = document.querySelector<HTMLCanvasElement>("#screen")!;
const screenStage = document.querySelector<HTMLDivElement>(".screen-stage")!;
const playerPage = document.querySelector<HTMLElement>("#playerPage")!;
const settingsPage = document.querySelector<HTMLElement>("#settingsPage")!;

const fpsInput = document.querySelector<HTMLInputElement>("#fpsInput")!;
const sizeInput = document.querySelector<HTMLInputElement>("#sizeInput")!;
const bitrateInput = document.querySelector<HTMLInputElement>("#bitrateInput")!;
const videoBufferInput = document.querySelector<HTMLInputElement>("#videoBufferInput")!;
const codecInput = document.querySelector<HTMLSelectElement>("#codecInput")!;
const rootModeInput = document.querySelector<HTMLSelectElement>("#rootModeInput")!;
const screenOffInput = document.querySelector<HTMLInputElement>("#screenOffInput")!;
const keepAwakeInput = document.querySelector<HTMLInputElement>("#keepAwakeInput")!;
const powerOffOnCloseInput = document.querySelector<HTMLInputElement>("#powerOffOnCloseInput")!;
const audioEnabledInput = document.querySelector<HTMLInputElement>("#audioEnabledInput")!;

let decoder: WebCodecsVideoDecoder | undefined;
let currentStream: StreamStartPayload | undefined;
let frameCounter = 0;
let lastFpsTick = performance.now();
let activePointerId: number | undefined;
let decoderWriter: WritableStreamDefaultWriter<ScrcpyMediaStreamPacket> | undefined;
let decodeLoopRunning = false;
let droppedPackets = 0;
const packetQueue: VideoPacketPayload[] = [];
const maxQueuedPackets = 12;
let videoAspectRatio = 9 / 16;
let firstFrameNotified = false;
let decodedPacketCount = 0;
let currentStatus = "idle";
let videoBufferMs = 50;
let firstQueuedPacketAt = 0;
let bufferTimer: number | undefined;

const specialKeyboardMap: Record<string, string> = {
  Enter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  Escape: "Escape",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  " ": "Space",
};

function post(message: WebviewToExtensionMessage): void {
  vscode.postMessage(message);
}

function setStatus(text: string, extra?: string): void {
  currentStatus = text;
  statusText.textContent = text;
  detail.textContent = extra ?? "";
  const meta =
    text === "正在投屏" || text === "streaming" ? { icon: "●", label: "正在投屏", state: "streaming" } :
    text === "connecting" || text === "reconnecting" || text === "elevating" ? { icon: "↻", label: text, state: "active" } :
    text === "连接已断开" || text === "disconnected" ? { icon: "○", label: "连接已断开", state: "idle" } :
    text === "错误" || text === "解码失败" ? { icon: "!", label: text, state: "error" } :
    { icon: "○", label: text || "空闲", state: "idle" };
  statusBadge.textContent = meta.icon;
  statusBadge.dataset.state = meta.state;
  statusBadge.title = meta.label;
  statusBadge.setAttribute("aria-label", meta.label);
  updateConnectButton();
}

function setConfigInputs(config: StreamStartPayload["config"]): void {
  fpsInput.value = String(config.maxFps);
  sizeInput.value = String(config.maxSize);
  bitrateInput.value = String(config.videoBitRate);
  videoBufferInput.value = String(config.videoBufferMs);
  videoBufferMs = config.videoBufferMs;
  codecInput.value = config.videoCodec;
  rootModeInput.value = config.rootMode ?? "auto";
  screenOffInput.checked = config.screenOffOnStart ?? true;
  keepAwakeInput.checked = config.keepScreenAwake ?? true;
  powerOffOnCloseInput.checked = config.powerOffOnClose ?? true;
  audioEnabledInput.checked = config.audioEnabled ?? false;
}

function readNumberInput(input: HTMLInputElement, min: number): number | undefined {
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < min) {
    input.setCustomValidity(`请输入不小于 ${min} 的数字`);
    input.reportValidity();
    return undefined;
  }
  input.setCustomValidity("");
  return Math.floor(value);
}

function setMode(mode?: "standard" | "root" | "pending" | "view-only"): void {
  const meta =
    mode === "standard" ? { icon: "S", label: "标准控制" } :
    mode === "root" ? { icon: "#", label: "Root 控制" } :
    mode === "view-only" ? { icon: "👁", label: "仅观看" } :
    { icon: "…", label: "控制模式待定" };
  modeBadge.textContent = meta.icon;
  modeBadge.dataset.mode = mode ?? "pending";
  modeBadge.title = meta.label;
  modeBadge.setAttribute("aria-label", meta.label);
}

function setDeviceScreenState(state: "on" | "off" | "unknown"): void {
  const meta =
    state === "on" ? { icon: "☀", label: "真机亮屏" } :
    state === "off" ? { icon: "◼", label: "真机黑屏" } :
    { icon: "?", label: "真机屏幕状态未知" };
  screenStateBadge.dataset.state = state;
  screenStateBadge.textContent = meta.icon;
  screenStateBadge.title = meta.label;
  screenStateBadge.setAttribute("aria-label", meta.label);
}

function setOverlayVisible(visible: boolean): void {
  overlay.classList.toggle("hidden", !visible);
}

function setPage(page: "player" | "settings"): void {
  playerPage.classList.toggle("active", page === "player");
  settingsPage.classList.toggle("active", page === "settings");
  requestAnimationFrame(updateCanvasLayout);
}

function updateConnectButton(): void {
  const active =
    currentStatus === "streaming" ||
    currentStatus === "connecting" ||
    currentStatus === "reconnecting" ||
    currentStatus === "elevating";
  connectBtn.dataset.state = active ? "connected" : "disconnected";
  connectBtn.setAttribute("aria-label", active ? "断开设备" : "连接设备");
  connectBtn.title = active ? "断开设备" : "连接设备";
}

function disposeDecoder(): void {
  decoderWriter?.releaseLock();
  decoderWriter = undefined;
  decoder?.dispose();
  decoder = undefined;
  canvas.width = 0;
  canvas.height = 0;
  canvas.style.aspectRatio = "";
  canvas.style.width = "0px";
  canvas.style.height = "0px";
  packetQueue.length = 0;
  decodeLoopRunning = false;
  droppedPackets = 0;
  firstQueuedPacketAt = 0;
  if (bufferTimer !== undefined) {
    window.clearTimeout(bufferTimer);
    bufferTimer = undefined;
  }
  firstFrameNotified = false;
  decodedPacketCount = 0;
}

function updateCanvasLayout(): void {
  const bounds = screenStage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) {
    return;
  }

  const stageRatio = bounds.width / bounds.height;
  const ratio = videoAspectRatio || (9 / 16);

  let width = bounds.width;
  let height = width / ratio;

  if (height > bounds.height) {
    height = bounds.height;
    width = height * ratio;
  }

  canvas.style.width = `${Math.max(1, Math.floor(width))}px`;
  canvas.style.height = `${Math.max(1, Math.floor(height))}px`;
}

const resizeObserver = new ResizeObserver(() => {
  updateCanvasLayout();
});

resizeObserver.observe(screenStage);

function packetToMediaPacket(packet: VideoPacketPayload): ScrcpyMediaStreamPacket {
  const binary = new Uint8Array(packet.data);
  if (packet.type === "configuration") {
    return {
      type: "configuration",
      data: binary,
    };
  }

  return {
    type: "data",
    data: binary,
    keyframe: packet.keyframe,
    pts: packet.pts ? BigInt(packet.pts) : undefined,
  };
}

async function startStream(payload: StreamStartPayload): Promise<void> {
  disposeDecoder();
  currentStream = payload;
  deviceLabel.textContent = payload.deviceName;
  deviceSub.textContent = `${payload.serial} · ${payload.width}×${payload.height}`;
  setConfigInputs(payload.config);

  try {
    const renderer = WebGLVideoFrameRenderer.isSupported
      ? new WebGLVideoFrameRenderer(canvas)
      : new BitmapVideoFrameRenderer(canvas);
    decoder = new WebCodecsVideoDecoder({
      codec: payload.codecId as ScrcpyVideoCodecId,
      renderer,
    });
    decoderWriter = decoder.writable.getWriter();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    setOverlayVisible(true);
    setStatus("解码失败", detail);
    post({ type: "decoder-error", detail });
    return;
  }

  decoder.sizeChanged(({ width, height }) => {
    canvas.width = width;
    canvas.height = height;
    videoAspectRatio = width / height;
    canvas.style.aspectRatio = `${width} / ${height}`;
    updateCanvasLayout();
  });
  if (payload.width && payload.height) {
    videoAspectRatio = payload.width / payload.height;
    canvas.style.aspectRatio = `${payload.width} / ${payload.height}`;
  }
  updateCanvasLayout();
  setOverlayVisible(false);
  setStatus("正在投屏", `${payload.serial} · ${payload.width}x${payload.height}`);
  setMode(payload.controlMode);
}

async function pumpDecoder(): Promise<void> {
  if (decodeLoopRunning || !decoderWriter || !decoder) {
    return;
  }
  decodeLoopRunning = true;
  try {
    while (packetQueue.length && decoderWriter && decoder) {
      const packet = packetQueue.shift()!;
      try {
        await decoderWriter.write(packetToMediaPacket(packet));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setOverlayVisible(true);
        setStatus("解码失败", detail);
        post({ type: "decoder-error", detail });
        disposeDecoder();
        return;
      }
      frameCounter += 1;
      decodedPacketCount += 1;
      if (!firstFrameNotified && (decoder.framesRendered > 0 || decodedPacketCount >= 3)) {
        firstFrameNotified = true;
        post({ type: "video-ready" });
      }
      const now = performance.now();
      const elapsed = now - lastFpsTick;
      if (elapsed >= 1000) {
        metrics.textContent = `FPS: ${Math.round((frameCounter * 1000) / elapsed)} · Rendered: ${decoder.framesRendered} · Skipped: ${decoder.framesSkipped} · Dropped: ${droppedPackets}`;
        lastFpsTick = now;
        frameCounter = 0;
      }
    }
  } finally {
    decodeLoopRunning = false;
    if (packetQueue.length && decoderWriter && decoder) {
      void pumpDecoder();
    }
  }
}

function enqueueVideo(packet: VideoPacketPayload): void {
  if (!decoder) {
    return;
  }

  if (packetQueue.length === 0) {
    firstQueuedPacketAt = performance.now();
  }

  if (packetQueue.length >= maxQueuedPackets) {
    if (packet.type === "data" && !packet.keyframe) {
      droppedPackets += 1;
      return;
    }

    for (let i = 0; i < packetQueue.length - 1; i += 1) {
      const queued = packetQueue[i];
      if (queued?.type === "data" && !queued.keyframe) {
        packetQueue.splice(i, 1);
        droppedPackets += 1;
        break;
      }
    }
  }

  packetQueue.push(packet);
  const bufferedFor = performance.now() - firstQueuedPacketAt;
  if (videoBufferMs > 0 && bufferedFor < videoBufferMs) {
    if (bufferTimer === undefined) {
      bufferTimer = window.setTimeout(() => {
        bufferTimer = undefined;
        void pumpDecoder();
      }, Math.max(0, videoBufferMs - bufferedFor));
    }
    return;
  }
  void pumpDecoder();
}

function mapPoint(event: PointerEvent): { x: number; y: number } | undefined {
  if (!currentStream || canvas.width === 0 || canvas.height === 0) {
    return undefined;
  }

  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return undefined;
  }

  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  return { x, y };
}

function sendPointer(phase: "down" | "move" | "up", event: PointerEvent): void {
  const point = mapPoint(event);
  if (!point) {
    return;
  }

  post({
    type: "pointer",
    phase,
    pointerId: event.pointerId,
    x: point.x,
    y: point.y,
    width: canvas.width,
    height: canvas.height,
    pressure: event.pressure || (phase === "up" ? 0 : 1),
    buttons: event.buttons,
  });
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button === 2) {
    event.preventDefault();
    post({ type: "key", key: "back" });
    return;
  }
  event.preventDefault();
  canvas.focus();
  activePointerId = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  sendPointer("down", event);
});

canvas.addEventListener("pointermove", (event) => {
  if (activePointerId !== event.pointerId) {
    return;
  }
  event.preventDefault();
  sendPointer("move", event);
});

canvas.addEventListener("pointerup", (event) => {
  if (activePointerId !== event.pointerId) {
    return;
  }
  event.preventDefault();
  sendPointer("up", event);
  activePointerId = undefined;
});

canvas.addEventListener("pointercancel", (event) => {
  if (activePointerId !== event.pointerId) {
    return;
  }
  event.preventDefault();
  sendPointer("up", event);
  activePointerId = undefined;
});

canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

function handleKeyboardEvent(event: KeyboardEvent, action: "down" | "up"): void {
  if (!currentStream || !playerPage.classList.contains("active") || document.activeElement !== canvas) {
    return;
  }

  const target = event.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return;
  }

  const special = specialKeyboardMap[event.key];
  const isPlainText =
    action === "down" &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.length === 1 &&
    !special;

  if (isPlainText) {
    event.preventDefault();
    post({ type: "keyboard-text", text: event.key });
    return;
  }

  event.preventDefault();
  post({
    type: "keyboard-event",
    action,
    key: special ?? event.key,
    code: event.code,
    repeat: event.repeat,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
  });
}

canvas.addEventListener("keydown", (event) => {
  handleKeyboardEvent(event, "down");
});

canvas.addEventListener("keyup", (event) => {
  handleKeyboardEvent(event, "up");
});

document.querySelector<HTMLButtonElement>("#settingsBtn")!.addEventListener("click", () => {
  setPage("settings");
});

connectBtn.addEventListener("click", () => {
  const active =
    currentStatus === "streaming" ||
    currentStatus === "connecting" ||
    currentStatus === "reconnecting" ||
    currentStatus === "elevating";
  post({ type: active ? "disconnect" : "select-device" });
});

document.querySelector<HTMLButtonElement>("#backToPlayerBtn")!.addEventListener("click", () => {
  setPage("player");
});

document.querySelector<HTMLButtonElement>("#reconnectBtn")!.addEventListener("click", () => {
  post({ type: "reconnect" });
});

document.querySelector<HTMLButtonElement>("#backBtn")!.addEventListener("click", () => {
  post({ type: "key", key: "back" });
});

document.querySelector<HTMLButtonElement>("#homeBtn")!.addEventListener("click", () => {
  post({ type: "key", key: "home" });
});

document.querySelector<HTMLButtonElement>("#tasksBtn")!.addEventListener("click", () => {
  post({ type: "key", key: "appSwitch" });
});

document.querySelector<HTMLButtonElement>("#powerBtn")!.addEventListener("click", () => {
  post({ type: "key", key: "power" });
});

document.querySelector<HTMLButtonElement>("#applyBtn")!.addEventListener("click", () => {
  const maxFps = readNumberInput(fpsInput, 0);
  const maxSize = readNumberInput(sizeInput, 0);
  const videoBitRate = readNumberInput(bitrateInput, 1000000);
  const nextVideoBufferMs = readNumberInput(videoBufferInput, 0);
  if (maxFps === undefined || maxSize === undefined || videoBitRate === undefined || nextVideoBufferMs === undefined) {
    setStatus("参数无效", "请检查播放设置里的数字输入");
    return;
  }

  post({
    type: "apply-config",
    config: {
      maxFps,
      maxSize,
      videoBitRate,
      videoBufferMs: nextVideoBufferMs,
      videoCodec: codecInput.value as "h264" | "h265" | "av1",
      rootMode: rootModeInput.value as "auto" | "always" | "never",
      screenOffOnStart: screenOffInput.checked,
      keepScreenAwake: keepAwakeInput.checked,
      powerOffOnClose: powerOffOnCloseInput.checked,
      audioEnabled: audioEnabledInput.checked,
    },
  });
});

window.addEventListener("message", (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "state":
      setStatus(message.status, message.detail);
      setOverlayVisible(message.status !== "streaming");
      setMode(message.mode);
      return;
    case "config":
      setConfigInputs(message.config);
      return;
    case "stream-start":
      void startStream(message.payload);
      return;
    case "stream-stop":
      disposeDecoder();
      currentStream = undefined;
      setOverlayVisible(true);
      setStatus("连接已断开", message.detail);
      return;
    case "video":
      enqueueVideo(message.packet);
      return;
    case "devices":
      if (!message.currentSerial && message.devices.length === 0) {
        deviceLabel.textContent = "No device";
        deviceSub.textContent = "Plug in USB or connect over ADB TCP";
      } else if (message.currentSerial) {
        const current = message.devices.find((item) => item.serial === message.currentSerial);
        if (current) {
          deviceLabel.textContent = current.name;
          deviceSub.textContent = `${current.serial} · ${current.state}`;
        }
      }
      return;
    case "device-screen":
      setDeviceScreenState(message.state);
      return;
    case "error":
      setOverlayVisible(true);
      setStatus("错误", message.message);
      return;
    case "metrics":
      metrics.textContent = `FPS: ${message.fps} · Rendered: ${message.renderedFrames} · Skipped: ${message.skippedFrames}`;
      return;
  }
});

post({ type: "ready" });
updateConnectButton();
setDeviceScreenState("unknown");
