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
const overlayIcon = document.querySelector<HTMLSpanElement>("#overlayIcon")!;
const overlayTitle = document.querySelector<HTMLElement>("#overlayTitle")!;
const overlayDetail = document.querySelector<HTMLSpanElement>("#overlayDetail")!;
const overlayActionBtn = document.querySelector<HTMLButtonElement>("#overlayActionBtn")!;
const metrics = document.querySelector<HTMLSpanElement>("#metrics")!;
const detail = document.querySelector<HTMLSpanElement>("#detail")!;
const statusChip = document.querySelector<HTMLSpanElement>("#statusChip")!;
const statusChipText = document.querySelector<HTMLSpanElement>("#statusChipText")!;
const screenChip = document.querySelector<HTMLSpanElement>("#screenChip")!;
const screenChipText = document.querySelector<HTMLSpanElement>("#screenChipText")!;
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
const keepActiveInput = document.querySelector<HTMLInputElement>("#keepActiveInput")!;
const flexDisplayInput = document.querySelector<HTMLInputElement>("#flexDisplayInput")!;
const powerOffOnCloseInput = document.querySelector<HTMLInputElement>("#powerOffOnCloseInput")!;
const audioEnabledInput = document.querySelector<HTMLInputElement>("#audioEnabledInput")!;
const adaptiveInput = document.querySelector<HTMLInputElement>("#adaptiveInput")!;
const presetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".preset-btn"));

const qualityPresets: Record<string, { maxFps: number; maxSize: number; videoBitRate: number; videoBufferMs: number }> = {
  mobile: { maxFps: 24, maxSize: 960, videoBitRate: 1800000, videoBufferMs: 150 },
  remote: { maxFps: 30, maxSize: 1080, videoBitRate: 3000000, videoBufferMs: 80 },
  lan: { maxFps: 30, maxSize: 1280, videoBitRate: 6000000, videoBufferMs: 20 },
};

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
let videoBufferMs = 50;
let lastFlexResize = { width: 0, height: 0 };
let flexResizeTimer: number | undefined;
let firstQueuedPacketAt = 0;
let bufferTimer: number | undefined;
let touchpadDragPoint: { x: number; y: number } | undefined;
let touchpadDragStartPoint: { x: number; y: number } | undefined;
let touchpadPendingMovePoint: { x: number; y: number } | undefined;
let touchpadMoveFrame: number | undefined;
let touchpadQueuedVideoDeltaX = 0;
let touchpadQueuedVideoDeltaY = 0;
let touchpadDragLastAt = 0;
let touchpadDragEndTimer: number | undefined;
let touchpadDragAccumulatedX = 0;
let touchpadDragAccumulatedY = 0;
let touchpadMomentumSuppressUntil = 0;
let touchpadFlingInProgress = false;
let touchpadLastGestureEndAt = 0;

const touchpadDragEndDelayMs = 70;
const touchpadHorizontalEndDelayMs = 28;
const touchpadDragRestartGapMs = 140;
const touchpadDragStartThresholdPx = 10;
const touchpadMaxMoveStepPx = 42;
const touchpadMomentumTailThresholdPx = 6;
const touchpadMomentumTailWindowMs = 450;
const touchpadHorizontalAccumulateGapMs = 140;
const touchpadMomentumSuppressMs = 220;
const touchpadFlingThresholdPx = 48;
const touchpadFlingVerticalRatio = 0.35;
const touchpadFlingDistanceRatio = 0.78;
const touchpadFlingSuppressMs = 850;
const touchpadHorizontalIntentRatio = 1.25;
const touchpadVerticalIntentRatio = 1.15;
const touchpadVerticalDamping = 0.82;

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

type UiStatus =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "elevating"
  | "streaming"
  | "disconnected"
  | "error"
  | "decode-error"
  | "invalid-input";

const statusMeta: Record<UiStatus, { icon: string; label: string; state: "idle" | "active" | "streaming" | "error" }> = {
  idle: { icon: "○", label: "未连接", state: "idle" },
  connecting: { icon: "↻", label: "连接中", state: "active" },
  reconnecting: { icon: "↻", label: "重连中", state: "active" },
  elevating: { icon: "↻", label: "切换 Root", state: "active" },
  streaming: { icon: "●", label: "投屏中", state: "streaming" },
  disconnected: { icon: "○", label: "已断开", state: "idle" },
  error: { icon: "!", label: "错误", state: "error" },
  "decode-error": { icon: "!", label: "解码失败", state: "error" },
  "invalid-input": { icon: "!", label: "参数无效", state: "error" },
};

const modeLabels: Record<"standard" | "root" | "pending" | "view-only", string> = {
  standard: "标准",
  root: "Root",
  "view-only": "仅观看",
  pending: "",
};

let currentStatus: UiStatus = "idle";
let currentDetail = "";
let currentMode: "standard" | "root" | "pending" | "view-only" = "pending";

function normalizeStatus(status: string): UiStatus {
  return (status in statusMeta ? status : "idle") as UiStatus;
}

function isBusyStatus(status: UiStatus): boolean {
  return status === "streaming" || status === "connecting" || status === "reconnecting" || status === "elevating";
}

function updateOverlayCard(): void {
  const meta = statusMeta[currentStatus];
  overlayIcon.textContent = meta.icon;
  overlayTitle.textContent = currentStatus === "idle" && !currentStream ? "未连接设备" : meta.label;
  overlayDetail.textContent = currentDetail;
  overlayDetail.hidden = !currentDetail;
  overlayActionBtn.hidden = isBusyStatus(currentStatus);
  overlayActionBtn.textContent = currentStatus === "idle" ? "选择设备" : "重新连接";
  overlay.classList.toggle("busy", currentStatus !== "streaming" && isBusyStatus(currentStatus));
}

function renderStatusChip(): void {
  const meta = statusMeta[currentStatus];
  const modeSuffix = currentStatus === "streaming" && modeLabels[currentMode] ? ` · ${modeLabels[currentMode]}` : "";
  const text = `${meta.label}${modeSuffix}`;
  statusChipText.textContent = text;
  statusChip.dataset.state = meta.state;
  statusChip.title = currentDetail ? `${text} — ${currentDetail}` : text;
  statusChip.setAttribute("aria-label", statusChip.title);
}

function setStatus(status: UiStatus, extra?: string): void {
  currentStatus = status;
  currentDetail = extra ?? "";
  const meta = statusMeta[status];
  statusText.textContent = meta.label;
  detail.textContent = currentDetail;
  renderStatusChip();
  updateOverlayCard();
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
  keepActiveInput.checked = config.keepActive ?? true;
  flexDisplayInput.checked = config.flexDisplay ?? false;
  powerOffOnCloseInput.checked = config.powerOffOnClose ?? true;
  audioEnabledInput.checked = config.audioEnabled ?? false;
  adaptiveInput.checked = config.adaptiveQuality ?? true;
  updatePresetHighlight();
}

function updatePresetHighlight(): void {
  for (const button of presetButtons) {
    const preset = qualityPresets[button.dataset.preset ?? ""];
    const active =
      !!preset &&
      Number(fpsInput.value) === preset.maxFps &&
      Number(sizeInput.value) === preset.maxSize &&
      Number(bitrateInput.value) === preset.videoBitRate &&
      Number(videoBufferInput.value) === preset.videoBufferMs;
    button.classList.toggle("is-active", active);
  }
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
  currentMode = mode ?? "pending";
  renderStatusChip();
}

function setDeviceScreenState(state: "on" | "off" | "unknown"): void {
  const meta =
    state === "on" ? { label: "亮屏", title: "真机屏幕已点亮" } :
    state === "off" ? { label: "已熄屏", title: "真机屏幕已熄灭(操作照常生效)" } :
    { label: "", title: "" };
  screenChip.hidden = state === "unknown";
  screenChip.dataset.state = state;
  screenChipText.textContent = meta.label;
  screenChip.title = meta.title;
  screenChip.setAttribute("aria-label", meta.title);
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
  const active = isBusyStatus(currentStatus);
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
  if (flexResizeTimer !== undefined) {
    window.clearTimeout(flexResizeTimer);
    flexResizeTimer = undefined;
  }
  firstFrameNotified = false;
  decodedPacketCount = 0;
  lastFlexResize = { width: 0, height: 0 };
}

function updateCanvasLayout(): void {
  const bounds = screenStage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) {
    return;
  }

  if (currentStream?.config.flexDisplay) {
    const width = Math.max(1, Math.floor(bounds.width));
    const height = Math.max(1, Math.floor(bounds.height));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    scheduleFlexDisplayResizeFromCanvas();
    return;
  }

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
resizeObserver.observe(canvas);

function scheduleFlexDisplayResizeFromCanvas(): void {
  if (!currentStream?.config.flexDisplay) {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }

  const nextWidth = Math.max(1, Math.min(65535, Math.floor(rect.width)));
  const nextHeight = Math.max(1, Math.min(65535, Math.floor(rect.height)));
  if (lastFlexResize.width === nextWidth && lastFlexResize.height === nextHeight) {
    return;
  }

  lastFlexResize = { width: nextWidth, height: nextHeight };
  if (flexResizeTimer !== undefined) {
    window.clearTimeout(flexResizeTimer);
  }
  flexResizeTimer = window.setTimeout(() => {
    flexResizeTimer = undefined;
    post({ type: "resize-display", width: nextWidth, height: nextHeight });
  }, 80);
}

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
  deviceLabel.title = `${payload.deviceName} · ${payload.serial}`;
  deviceSub.textContent =
    payload.width > 0 ? `${payload.serial} · ${payload.width}×${payload.height}` : payload.serial;
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
    setStatus("decode-error", detail);
    post({ type: "decoder-error", detail });
    return;
  }

  decoder.sizeChanged(({ width, height }) => {
    canvas.width = width;
    canvas.height = height;
    videoAspectRatio = width / height;
    canvas.style.aspectRatio = `${width} / ${height}`;
    deviceSub.textContent = `${payload.serial} · ${width}×${height}`;
    updateCanvasLayout();
  });
  if (payload.width && payload.height) {
    videoAspectRatio = payload.width / payload.height;
    canvas.style.aspectRatio = `${payload.width} / ${payload.height}`;
  }
  updateCanvasLayout();
  setOverlayVisible(false);
  setStatus("streaming", `${payload.serial} · ${payload.width}x${payload.height}`);
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
        setStatus("decode-error", detail);
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

  // Delta frames reference each other: dropping one corrupts every frame until
  // the next keyframe (black screen with ghost regions on movement). The only
  // safe catch-up point is a keyframe, which resets the decoder references —
  // when one arrives on an overflowing queue, everything older can be skipped.
  // Without a keyframe the queue must keep all packets; the decoder skips
  // rendering (framesSkipped) to catch up instead.
  if (packetQueue.length >= maxQueuedPackets && packet.type === "data" && packet.keyframe) {
    for (let i = packetQueue.length - 1; i >= 0; i -= 1) {
      if (packetQueue[i]?.type === "data") {
        packetQueue.splice(i, 1);
        droppedPackets += 1;
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

function mapClientPoint(clientX: number, clientY: number): { x: number; y: number } | undefined {
  if (!currentStream || canvas.width === 0 || canvas.height === 0) {
    return undefined;
  }

  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return undefined;
  }

  const x = ((clientX - rect.left) / rect.width) * canvas.width;
  const y = ((clientY - rect.top) / rect.height) * canvas.height;
  return { x, y };
}

function mapPoint(event: PointerEvent): { x: number; y: number } | undefined {
  return mapClientPoint(event.clientX, event.clientY);
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

function normalizeWheelDelta(event: WheelEvent): { deltaX: number; deltaY: number } {
  const deltaModeScale =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 :
    event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 800 :
    1;
  const deltaX = event.deltaX * deltaModeScale;
  const deltaY = event.deltaY * deltaModeScale;
  return { deltaX, deltaY };
}

// Discrete mouse wheels report whole notches: LINE/PAGE delta mode, or in pixel mode a
// single-axis delta that is a multiple of 100 (Chromium) or 120 (Windows convention).
// Trackpads stream small fractional two-axis deltas and never match this.
function isDiscreteWheelEvent(event: WheelEvent): boolean {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
    return true;
  }

  const absX = Math.abs(event.deltaX);
  const absY = Math.abs(event.deltaY);
  const single = (absX < 0.001) !== (absY < 0.001);
  if (!single) {
    return false;
  }

  const magnitude = Math.max(absX, absY);
  return magnitude >= 100 && (magnitude % 100 < 0.001 || magnitude % 120 < 0.001);
}

function sendNativeScroll(point: { x: number; y: number }, deltaX: number, deltaY: number): void {
  post({
    type: "scroll",
    x: point.x,
    y: point.y,
    width: canvas.width,
    height: canvas.height,
    scrollX: -deltaX / 100,
    scrollY: -deltaY / 100,
  });
}

function clampCanvasPoint(point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(canvas.width, point.x)),
    y: Math.max(0, Math.min(canvas.height, point.y)),
  };
}

function sendSyntheticPointer(phase: "down" | "move" | "up", point: { x: number; y: number }): void {
  post({
    type: "pointer",
    phase,
    pointerId: -20,
    x: point.x,
    y: point.y,
    width: canvas.width,
    height: canvas.height,
    pressure: phase === "up" ? 0 : 1,
    buttons: phase === "up" ? 0 : 1,
  });
}

function runTouchpadHorizontalFling(startPoint: { x: number; y: number }, direction: number): void {
  if (touchpadFlingInProgress || !canvas.width || !canvas.height) {
    return;
  }

  finishTouchpadDrag();
  touchpadFlingInProgress = true;
  touchpadMomentumSuppressUntil = performance.now() + touchpadFlingSuppressMs;
  touchpadDragLastAt = 0;

  const directionSign = Math.sign(direction || 1);
  const edgeInset = Math.max(2, Math.round(canvas.width * 0.015));
  const start = clampCanvasPoint({
    x: directionSign > 0 ? canvas.width - edgeInset : edgeInset,
    y: Math.max(canvas.height * 0.18, Math.min(canvas.height * 0.82, startPoint.y)),
  });
  const end = clampCanvasPoint({
    x: directionSign > 0 ? edgeInset : canvas.width - edgeInset,
    y: start.y,
  });
  const points = [
    {
      x: start.x + (end.x - start.x) * 0.42,
      y: start.y,
    },
    {
      x: start.x + (end.x - start.x) * 0.82,
      y: start.y,
    },
    end,
  ];

  sendSyntheticPointer("down", start);
  let index = 0;
  const step = () => {
    const point = points[index];
    if (!point) {
      sendSyntheticPointer("up", end);
      touchpadFlingInProgress = false;
      touchpadLastGestureEndAt = performance.now();
      resetTouchpadDragState();
      return;
    }
    sendSyntheticPointer("move", clampCanvasPoint(point));
    index += 1;
    window.setTimeout(step, index === points.length ? 10 : 8);
  };
  window.setTimeout(step, 6);
}

function shouldTriggerTouchpadHorizontalFling(deltaX: number, deltaY: number): boolean {
  if (touchpadDragPoint || touchpadFlingInProgress) {
    return false;
  }

  const absX = Math.abs(touchpadDragAccumulatedX + deltaX);
  const absY = Math.abs(touchpadDragAccumulatedY + deltaY);
  return absX >= touchpadFlingThresholdPx && absY <= absX * touchpadFlingVerticalRatio;
}

function flushTouchpadMove(): void {
  while (touchpadDragPoint && (Math.abs(touchpadQueuedVideoDeltaX) >= 0.5 || Math.abs(touchpadQueuedVideoDeltaY) >= 0.5)) {
    drainTouchpadMoveStep();
  }
}

function drainTouchpadMoveStep(): void {
  if (!touchpadDragPoint) {
    touchpadQueuedVideoDeltaX = 0;
    touchpadQueuedVideoDeltaY = 0;
    touchpadPendingMovePoint = undefined;
    return;
  }

  const magnitude = Math.hypot(touchpadQueuedVideoDeltaX, touchpadQueuedVideoDeltaY);
  if (magnitude < 0.5) {
    touchpadQueuedVideoDeltaX = 0;
    touchpadQueuedVideoDeltaY = 0;
    touchpadPendingMovePoint = undefined;
    return;
  }

  const scale = Math.min(1, touchpadMaxMoveStepPx / magnitude);
  const stepX = touchpadQueuedVideoDeltaX * scale;
  const stepY = touchpadQueuedVideoDeltaY * scale;
  touchpadQueuedVideoDeltaX -= stepX;
  touchpadQueuedVideoDeltaY -= stepY;
  touchpadDragPoint = clampCanvasPoint({
    x: touchpadDragPoint.x - stepX,
    y: touchpadDragPoint.y - stepY,
  });
  touchpadPendingMovePoint = touchpadDragPoint;
  sendSyntheticPointer("move", touchpadDragPoint);
}

function scheduleTouchpadMove(deltaX: number, deltaY: number): void {
  touchpadQueuedVideoDeltaX += deltaX;
  touchpadQueuedVideoDeltaY += deltaY;
  if (touchpadMoveFrame !== undefined) {
    return;
  }

  touchpadMoveFrame = window.requestAnimationFrame(() => {
    touchpadMoveFrame = undefined;
    drainTouchpadMoveStep();
    if (touchpadDragPoint && (Math.abs(touchpadQueuedVideoDeltaX) >= 0.5 || Math.abs(touchpadQueuedVideoDeltaY) >= 0.5)) {
      scheduleTouchpadMove(0, 0);
    }
  });
}

function resetTouchpadDragState(): void {
  touchpadDragPoint = undefined;
  touchpadDragStartPoint = undefined;
  touchpadDragAccumulatedX = 0;
  touchpadDragAccumulatedY = 0;
  touchpadPendingMovePoint = undefined;
  touchpadQueuedVideoDeltaX = 0;
  touchpadQueuedVideoDeltaY = 0;
  if (touchpadMoveFrame !== undefined) {
    window.cancelAnimationFrame(touchpadMoveFrame);
    touchpadMoveFrame = undefined;
  }
}

function finishTouchpadDrag(): void {
  if (touchpadDragEndTimer !== undefined) {
    window.clearTimeout(touchpadDragEndTimer);
    touchpadDragEndTimer = undefined;
  }

  if (!touchpadDragPoint) {
    resetTouchpadDragState();
    return;
  }

  const horizontalIntent = Math.abs(touchpadDragAccumulatedX) > Math.abs(touchpadDragAccumulatedY) * 1.35;
  flushTouchpadMove();
  sendSyntheticPointer("up", touchpadDragPoint);
  resetTouchpadDragState();
  touchpadLastGestureEndAt = performance.now();
  if (horizontalIntent) {
    touchpadMomentumSuppressUntil = performance.now() + touchpadMomentumSuppressMs;
  }
}

function shouldIgnoreTouchpadMomentumTail(deltaX: number, deltaY: number): boolean {
  if (touchpadDragPoint) {
    return false;
  }

  const now = performance.now();
  if (touchpadFlingInProgress || now <= touchpadMomentumSuppressUntil) {
    return Math.abs(deltaX) > Math.abs(deltaY) * 0.35;
  }

  // Small horizontal deltas are leftover macOS momentum only right after a gesture
  // ended; at any other time they are the start of a slow deliberate swipe and must
  // be allowed to accumulate toward the horizontal fling threshold.
  if (now - touchpadLastGestureEndAt > touchpadMomentumTailWindowMs) {
    return false;
  }

  const mostlyHorizontal = Math.abs(deltaX) > Math.abs(deltaY) * 1.2;
  const tailMagnitude = Math.hypot(deltaX, deltaY);
  return mostlyHorizontal && tailMagnitude < touchpadMomentumTailThresholdPx;
}

function moveTouchpadDrag(startPoint: { x: number; y: number }, deltaX: number, deltaY: number): void {
  const now = performance.now();
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }

  const shouldRestart = (!touchpadDragPoint && !touchpadDragStartPoint) || now - touchpadDragLastAt > touchpadDragRestartGapMs;
  if (shouldRestart) {
    finishTouchpadDrag();
    touchpadDragStartPoint = clampCanvasPoint(startPoint);
    touchpadDragAccumulatedX = 0;
    touchpadDragAccumulatedY = 0;
  }

  touchpadDragLastAt = now;
  touchpadDragAccumulatedX += deltaX;
  touchpadDragAccumulatedY += deltaY;

  const accumulatedAbsX = Math.abs(touchpadDragAccumulatedX);
  const accumulatedAbsY = Math.abs(touchpadDragAccumulatedY);
  const horizontalIntent = accumulatedAbsX > accumulatedAbsY * touchpadHorizontalIntentRatio;
  const verticalIntent = accumulatedAbsY > accumulatedAbsX * touchpadVerticalIntentRatio;
  if (!touchpadDragPoint && horizontalIntent) {
    if (touchpadDragEndTimer !== undefined) {
      window.clearTimeout(touchpadDragEndTimer);
    }
    // Accumulating toward the fling threshold without dragging: keep the accumulator
    // alive across normal wheel-event gaps, otherwise medium-speed swipes never reach it.
    touchpadDragEndTimer = window.setTimeout(finishTouchpadDrag, touchpadHorizontalAccumulateGapMs);
    return;
  }

  let moveDeltaX = deltaX;
  let moveDeltaY = deltaY;
  if (!touchpadDragPoint) {
    if (Math.hypot(touchpadDragAccumulatedX, touchpadDragAccumulatedY) < touchpadDragStartThresholdPx) {
      if (touchpadDragEndTimer !== undefined) {
        window.clearTimeout(touchpadDragEndTimer);
      }
      touchpadDragEndTimer = window.setTimeout(finishTouchpadDrag, touchpadDragEndDelayMs);
      return;
    }

    touchpadDragPoint = touchpadDragStartPoint ?? clampCanvasPoint(startPoint);
    sendSyntheticPointer("down", touchpadDragPoint);
    moveDeltaX = touchpadDragAccumulatedX;
    moveDeltaY = touchpadDragAccumulatedY;
  }

  const videoDeltaX = moveDeltaX * (canvas.width / rect.width);
  const videoDeltaY = moveDeltaY * (canvas.height / rect.height);
  scheduleTouchpadMove(
    verticalIntent ? 0 : videoDeltaX,
    videoDeltaY * (verticalIntent ? touchpadVerticalDamping : 1),
  );

  if (touchpadDragEndTimer !== undefined) {
    window.clearTimeout(touchpadDragEndTimer);
  }

  const isMomentumTail = Math.hypot(deltaX, deltaY) < touchpadMomentumTailThresholdPx;
  if (isMomentumTail && horizontalIntent) {
    touchpadDragEndTimer = window.setTimeout(finishTouchpadDrag, 0);
    return;
  }

  touchpadDragEndTimer = window.setTimeout(
    finishTouchpadDrag,
    horizontalIntent ? touchpadHorizontalEndDelayMs : touchpadDragEndDelayMs,
  );
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

canvas.addEventListener("wheel", (event) => {
  const point = mapClientPoint(event.clientX, event.clientY);
  if (!point) {
    return;
  }

  const { deltaX, deltaY } = normalizeWheelDelta(event);
  if (Math.abs(deltaX) < 0.001 && Math.abs(deltaY) < 0.001) {
    return;
  }

  event.preventDefault();
  canvas.focus();
  if (isDiscreteWheelEvent(event) && !touchpadDragPoint && !touchpadFlingInProgress) {
    sendNativeScroll(point, deltaX, deltaY);
    return;
  }

  if (shouldIgnoreTouchpadMomentumTail(deltaX, deltaY)) {
    return;
  }

  if (shouldTriggerTouchpadHorizontalFling(deltaX, deltaY)) {
    runTouchpadHorizontalFling(point, touchpadDragAccumulatedX + deltaX);
    return;
  }

  moveTouchpadDrag(point, deltaX, deltaY);
}, { passive: false });

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

  // Paste host clipboard on Ctrl/Cmd+V or Shift+Insert; the extension sets the
  // device clipboard and pastes there, so the key itself must not go through.
  const primaryModifier = event.ctrlKey || event.metaKey;
  if (
    (primaryModifier && !event.altKey && !event.shiftKey && event.code === "KeyV") ||
    (event.shiftKey && !primaryModifier && !event.altKey && event.code === "Insert")
  ) {
    event.preventDefault();
    if (action === "down" && !event.repeat) {
      post({ type: "clipboard-paste" });
    }
    return;
  }

  const uhidEnabled = currentStream.config.uhidKeyboard !== false;
  const special = specialKeyboardMap[event.key];
  const isPlainText =
    !uhidEnabled &&
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

// Release all UHID keys when focus leaves the canvas so nothing stays "held".
canvas.addEventListener("blur", () => {
  if (currentStream) {
    post({ type: "keyboard-reset" });
  }
});

document.querySelector<HTMLButtonElement>("#settingsBtn")!.addEventListener("click", () => {
  setPage("settings");
});

connectBtn.addEventListener("click", () => {
  post({ type: isBusyStatus(currentStatus) ? "disconnect" : "select-device" });
});

overlayActionBtn.addEventListener("click", () => {
  if (isBusyStatus(currentStatus)) {
    return;
  }
  post({ type: currentStatus === "idle" ? "select-device" : "reconnect" });
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

function applySettings(): void {
  const maxFps = readNumberInput(fpsInput, 0);
  const maxSize = readNumberInput(sizeInput, 0);
  const videoBitRate = readNumberInput(bitrateInput, 1000000);
  const nextVideoBufferMs = readNumberInput(videoBufferInput, 0);
  if (maxFps === undefined || maxSize === undefined || videoBitRate === undefined || nextVideoBufferMs === undefined) {
    setStatus("invalid-input", "请检查播放设置里的数字输入");
    return;
  }

  updatePresetHighlight();
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
      keepActive: keepActiveInput.checked,
      flexDisplay: flexDisplayInput.checked,
      powerOffOnClose: powerOffOnCloseInput.checked,
      audioEnabled: audioEnabledInput.checked,
      adaptiveQuality: adaptiveInput.checked,
    },
  });
}

document.querySelector<HTMLButtonElement>("#applyBtn")!.addEventListener("click", applySettings);

for (const button of presetButtons) {
  button.addEventListener("click", () => {
    const preset = qualityPresets[button.dataset.preset ?? ""];
    if (!preset) {
      return;
    }
    fpsInput.value = String(preset.maxFps);
    sizeInput.value = String(preset.maxSize);
    bitrateInput.value = String(preset.videoBitRate);
    videoBufferInput.value = String(preset.videoBufferMs);
    applySettings();
  });
}

window.addEventListener("message", (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "state":
      setStatus(normalizeStatus(message.status), message.detail);
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
      setStatus("disconnected", message.detail);
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
      setStatus("error", message.message);
      return;
  }
});

// Report which codecs this webview's WebCodecs can decode so the extension can
// avoid starting the server with an undecodable codec (e.g. H.265 without HEVC support).
async function probeCodecSupport(): Promise<void> {
  const probe = async (codec: string): Promise<boolean> => {
    try {
      if (typeof VideoDecoder === "undefined") {
        return false;
      }
      const result = await VideoDecoder.isConfigSupported({
        codec,
        codedWidth: 1280,
        codedHeight: 720,
      });
      return result.supported === true;
    } catch {
      return false;
    }
  };
  const [h264, h265, av1] = await Promise.all([
    probe("avc1.42E01F"),
    probe("hev1.1.6.L120.90"),
    probe("av01.0.05M.08"),
  ]);
  post({ type: "codec-support", codecs: { h264, h265, av1 } });
}

// Sustained queue backlog means the transport or decoder cannot keep up with the
// current stream settings; report it so the extension can step quality down.
let congestionTicks = 0;
let lastCongestionReportAt = 0;
window.setInterval(() => {
  if (!decoder || !currentStream) {
    congestionTicks = 0;
    return;
  }
  congestionTicks = packetQueue.length >= 8 ? congestionTicks + 1 : 0;
  if (congestionTicks < 3) {
    return;
  }
  congestionTicks = 0;
  const now = Date.now();
  if (now - lastCongestionReportAt < 30000) {
    return;
  }
  lastCongestionReportAt = now;
  post({
    type: "congestion",
    queuedPackets: packetQueue.length,
    bufferedMs: Math.round(performance.now() - firstQueuedPacketAt),
  });
}, 1000);

post({ type: "ready" });
void probeCodecSupport();
updateConnectButton();
setDeviceScreenState("unknown");
