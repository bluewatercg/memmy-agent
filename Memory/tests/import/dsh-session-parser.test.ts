import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isZstdBuffer, decompressZstdFrames, findZstdFrameRanges } from "../../src/service/import/dsh/zstd-decoder.js";
import { parseDshSessionBuffer, parseDshSessionLines, type DshTurn } from "../../src/service/import/dsh/session-parser.js";

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
  it("decodes only frames after a committed offset", () => {
    const buf = readFileSync(REAL_SESSION);
    const frames = findZstdFrameRanges(buf);
    const committed = frames[2];
    const decoded = decompressZstdFrames(buf, { offset: committed?.end ?? 0 });
    expect(decoded.lastCompleteFrameEnd).toBe(buf.length);
    expect(decoded.completeFrames).toBe(frames.length - 3);
    expect(decoded.lines.length).toBeGreaterThan(0);
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

  it("continues an incomplete turn supplied from a prior frame", () => {
    const initial: DshTurn = {
      turn: 3,
      startSeq: 1,
      userMessages: [{ seq: 2, text: "old question" }],
      toolCalls: [{ seq: 3, step: 0, callId: "call-1", name: "read", arguments: "{}" }],
      startedAt: 1,
      complete: false,
    };
    const parsed = parseDshSessionLines([
      '{"type":"session","version":1,"id":"s","createdAt":1}',
      '{"type":"tool/result","seq":4,"data":{"callId":"call-1","result":"ok"}}',
      '{"type":"assistant/message","seq":5,"data":{"turn":3,"message":{"content":"done"}}}',
      '{"type":"turn/end","seq":6,"data":{"turn":3}}',
    ], { initialTurns: [initial] });
    expect(parsed.turns[0]).toMatchObject({ turn: 3, complete: true, endSeq: 6 });
    expect(parsed.turns[0]?.toolCalls[0]).toMatchObject({ callId: "call-1", resultSeq: 4 });
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
