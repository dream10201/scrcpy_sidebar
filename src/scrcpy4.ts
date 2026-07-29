import type { ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import { TransformStream } from "@yume-chan/stream-extra";

const Scrcpy4PacketFlagSession = 1n << 63n;
const Scrcpy4PacketFlagConfig = 1n << 62n;
const Scrcpy4PacketFlagKeyFrame = 1n << 61n;

export function isScrcpy4Version(version: string): boolean {
  return /^4(?:\.|$)/.test(version);
}

// scrcpy 4.x sends a raw framed media stream when send_stream_meta=false:
// 8-byte PTS+flags, 4-byte payload size, payload.
export function createScrcpy4MediaStreamTransformer(): TransformStream<Uint8Array, ScrcpyMediaStreamPacket> {
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
