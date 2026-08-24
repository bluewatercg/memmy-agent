// zstd frame decoder for DSH session logs.
// DSH writes session.jsonl.zstd as a concatenation of standard Zstandard
// frames: one header frame + one frame per append batch, each checksummed.
// Node's built-in zlib.zstdDecompressSync decompresses a single frame, so we
// locate frame boundaries by the zstd magic number and decompress each frame.
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_FRAME_BYTES = 256 * 1024 * 1024; // safety cap per frame

export interface ZstdFrameRange {
  start: number;
  end: number; // exclusive; == buffer.length for the final frame
}

export function findZstdFrameRanges(buffer: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = [];
  let pos = 0;
  while (true) {
    const idx = buffer.indexOf(ZSTD_MAGIC, pos);
    if (idx < 0) break;
    frames.push({ start: idx, end: 0 }); // end filled below
    pos = idx + ZSTD_MAGIC.length;
  }
  for (let i = 0; i < frames.length; i += 1) {
    const current = frames[i];
    if (!current) continue;
    const next = i + 1 < frames.length ? frames[i + 1] : undefined;
    frames[i] = {
      start: current.start,
      end: next ? next.start : buffer.length,
    };
  }
  return frames;
}

/** Decompress complete frames, optionally starting at a previously committed byte offset. */
export function decompressZstdFrames(
  buffer: Buffer,
  options: { maxBytes?: number; offset?: number } = {},
): { lines: string[]; completeFrames: number; lastCompleteFrameEnd: number; skippedTail: boolean } {
  const maxBytes = options.maxBytes ?? MAX_FRAME_BYTES;
  const offset = options.offset ?? 0;
  const ranges = findZstdFrameRanges(buffer);
  const all: string[] = [];
  let complete = 0;
  let skippedTail = false;
  let lastCompleteFrameEnd = offset;

  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i];
    if (!range || range.start < offset) continue;
    const frame = buffer.subarray(range.start, range.end);
    try {
      if (frame.length > maxBytes) throw new Error("zstd frame exceeds maxBytes");
      const out = zstdDecompressSync(frame);
      all.push(out.toString("utf8"));
      complete += 1;
      lastCompleteFrameEnd = range.end;
    } catch {
      skippedTail = i === ranges.length - 1 || i < ranges.length - 1;
      break;
    }
  }
  return {
    lines: all.join("").split("\n").filter((line) => line.trim().length > 0),
    completeFrames: complete,
    lastCompleteFrameEnd,
    skippedTail,
  };
}

export function isZstdBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(ZSTD_MAGIC);
}
