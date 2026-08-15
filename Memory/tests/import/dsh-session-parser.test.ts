import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isZstdBuffer, decompressZstdFrames, findZstdFrameRanges } from "../../src/service/import/dsh/zstd-decoder.js";
import { parseDshSessionBuffer, type DshTurn } from "../../src/service/import/dsh/session-parser.js";

// A real DSH session artifact (current workspace session) for integration checks.
const REAL_SESSION = "/root/.dsh/sessions/--mnt-d-Project-Miller-memmy-agent--/session-9a3105b3-a8fb-426d-a5b0-6a5212fbaf78/session.jsonl.zstd";

describe("dsh zstd decoder", () => {
  it("detects zstd magic", () => {
    const buf = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]);
    expect(isZstdBuffer(buf)).toBe(true);
    expect(isZstdBuffer(Buffer.from("plain jsonl\n"))).toBe(false);
  });

  it("decompresses a real multi-frame DSH session log", () => {
    const buf = readFileSync(REAL_SESSION);
    const frames = findZstdFrameRanges(buf);
    expect(frames.length).toBeGreaterThan(10); // header + many append frames
    const decoded = decompressZstdFrames(buf);
    expect(decoded.lines.length).toBeGreaterThan(100);
    expect(decoded.completeFrames).toBe(frames.length);
    expect(decoded.skippedTail).toBe(false);
  });

  it("tolerates a truncated tail frame", () => {
    const buf = readFileSync(REAL_SESSION);
    const truncated = buf.subarray(0, buf.length - 40); // cut into last frame
    const decoded = decompressZstdFrames(truncated);
    expect(decoded.completeFrames).toBeGreaterThanOrEqual(1);
  });
});

describe("dsh session parser", () => {
  it("parses header and turns from a real session", () => {
    const buf = readFileSync(REAL_SESSION);
    const parsed = parseDshSessionBuffer(buf);
    expect(parsed.header.type).toBe("session");
    expect(parsed.header.id).toBeTruthy();
    expect(parsed.header.cwd).toBeTruthy();
    expect(parsed.maxSeq).toBeGreaterThan(0);
    expect(parsed.totalEvents).toBeGreaterThan(0);
    expect(parsed.skippedCorrupt).toBe(0);
    const turns = parsed.turns;
    expect(turns.length).toBeGreaterThan(0);
    const first = turns[0] as DshTurn;
    expect(first.turn).toBeGreaterThanOrEqual(1);
    expect(first.startSeq).toBeGreaterThanOrEqual(0);
  });

  it("captures user messages and tool calls", () => {
    const buf = readFileSync(REAL_SESSION);
    const parsed = parseDshSessionBuffer(buf);
    const hasUser = parsed.turns.some((t) => t.userMessages.length > 0);
    const hasTools = parsed.turns.some((t) => t.toolCalls.length > 0);
    expect(hasUser).toBe(true);
    expect(hasTools).toBe(true);
  });

  it("marks completed turns", () => {
    const buf = readFileSync(REAL_SESSION);
    const parsed = parseDshSessionBuffer(buf);
    // At least one turn should be complete (turn/end seen) in a real session.
    const completed = parsed.turns.filter((t) => t.complete);
    expect(completed.length).toBeGreaterThan(0);
  });
});

describe("dsh session parser error handling", () => {
  it("rejects missing header", () => {
    const lines = ["{\"type\":\"turn/start\",\"seq\":0}"];
    expect(() => parseDshSessionBuffer(Buffer.from(lines.join("\n")))).toThrow(/header/);
  });

  it("skips corrupt lines without blocking", () => {
    const buf = readFileSync(REAL_SESSION);
    const text = decompressZstdFrames(buf).lines.join("\n");
    // inject a corrupt line after the header
    const first = text.indexOf("\n");
    const corrupted = text.slice(0, first + 1) + "{not valid json}\n" + text.slice(first + 1);
    const parsed = parseDshSessionBuffer(Buffer.from(corrupted));
    expect(parsed.skippedCorrupt).toBeGreaterThanOrEqual(1);
  });

  it("tolerates future unknown event types", () => {
    const header = JSON.stringify({ type: "session", version: 0, id: "s1", createdAt: 0, delegationDepth: 0 });
    const unknown = JSON.stringify({ type: "future/event", seq: 1, data: {} });
    const parsed = parseDshSessionBuffer(Buffer.from(header + "\n" + unknown + "\n"));
    expect(parsed.skippedCorrupt).toBe(0);
    expect(parsed.maxSeq).toBe(1);
  });
});
