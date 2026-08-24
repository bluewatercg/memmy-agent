// DSH session.jsonl(.zstd) parser: reads the SessionHeader line and the
// SessionEvent vocabulary into a normalized shape (DshTurn etc.) ready for
// import into Memmy. See design doc §4-§5.
import { decompressZstdFrames, isZstdBuffer } from "./zstd-decoder.js";

export interface DshSessionHeader {
  type: "session";
  version: number;
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  origin?: "subagent";
  delegationDepth?: number;
  seedLength?: number;
  agentPreset?: string;
}

export interface DshUserMessage {
  seq: number;
  text: string;
  id?: string;
}

export interface DshToolCall {
  seq: number;
  step: number;
  callId: string;
  name: string;
  arguments: string;
  result?: unknown;
  resultSeq?: number;
}

export interface DshTurn {
  turn: number;
  startSeq: number;
  endSeq?: number;
  userMessages: DshUserMessage[];
  toolCalls: DshToolCall[];
  startedAt: number;
  endedAt?: number;
  complete: boolean;
}

export interface ParsedDshSession {
  header: DshSessionHeader;
  turns: DshTurn[];
  maxSeq: number;
  totalEvents: number;
  skippedCorrupt: number;
}

export interface ParseOptions {
  maxEvents?: number; // safety cap; default 1_000_000
  initialTurns?: DshTurn[];
}

export function parseDshSessionLines(
  lines: string[],
  options: ParseOptions = {},
): ParsedDshSession {
  const maxEvents = options.maxEvents ?? 1_000_000;
  if (lines.length === 0) {
    throw new Error("dsh session log is empty");
  }
  const firstLine = lines[0];
  const first = firstLine === undefined ? undefined : parseLine(firstLine);
  if (!first || first.type !== "session") {
    throw new Error("dsh session log is missing a session header line");
  }
  const header = first as unknown as DshSessionHeader;

  const turns = new Map<number, DshTurn>();
  for (const initial of options.initialTurns ?? []) {
    turns.set(initial.turn, {
      ...initial,
      userMessages: [...initial.userMessages],
      toolCalls: initial.toolCalls.map((call) => ({ ...call })),
    });
  }
  let maxSeq = [...turns.values()].reduce((max, turn) => Math.max(max, turn.endSeq ?? turn.startSeq), 0);
  let skippedCorrupt = 0;

  for (let i = 1; i < lines.length; i += 1) {
    if (i > maxEvents) {
      throw new Error("dsh session exceeds maxEvents cap");
    }
    let event: Record<string, unknown>;
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(rawLine);
      if (!isRecord(parsed)) {
        skippedCorrupt += 1;
        continue;
      }
      event = parsed;
    } catch {
      skippedCorrupt += 1;
      continue;
    }
    const type = typeof event.type === "string" ? event.type : "";
    const seq = typeof event.seq === "number" ? event.seq
      : typeof event.seq0 === "number" ? event.seq0
      : -1;
    const time = typeof event.time === "number" ? event.time
      : typeof event.time0 === "number" ? event.time0
      : 0;
    if (seq >= 0) maxSeq = Math.max(maxSeq, seq);
    const data = isRecord(event.data) ? event.data : {};

    switch (type) {
      case "turn/start": {
        const turn = numberField(data, "turn");
        if (turn !== null && !turns.has(turn)) {
          turns.set(turn, {
            turn,
            startSeq: seq,
            userMessages: [],
            toolCalls: [],
            startedAt: time,
            complete: false,
          });
        }
        break;
      }
      case "turn/end": {
        const turn = numberField(data, "turn");
        const existing = turn !== null ? turns.get(turn) : undefined;
        if (existing) {
          existing.endSeq = seq;
          existing.endedAt = time;
          existing.complete = true;
        }
        break;
      }
      case "user/message": {
        const turn = currentTurn(turns, seq);
        if (!turn) break;
        const text = messageText(data.content);
        const id = stringField(data, "id");
        turn.userMessages.push({ seq, text, id });
        break;
      }
      case "tool/call": {
        const turn = currentTurn(turns, seq);
        if (!turn) break;
        const step = numberField(data, "step") ?? 0;
        const callId = stringField(data, "callId") ?? `dsh-tool-${seq}`;
        const name = stringField(data, "name") ?? "unknown";
        const args = typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? {});
        turn.toolCalls.push({ seq, step, callId, name, arguments: args });
        break;
      }
      case "tool/result": {
        const message = isRecord(data.message) ? data.message : {};
        const callId = stringField(message, "callId")
          ?? stringField(data, "callId")
          ?? stringField(message, "toolCallId");
        if (!callId) break;
        const target = findToolCall(turns, callId);
        if (target) {
          target.result = data.message ?? data;
          target.resultSeq = seq;
        }
        break;
      }
      case "session/title":
      case "step/start":
      case "step/end":
      case "assistant/message":
      case "assistant/chunk":
      case "reasoning-chunks":
      case "tool-call-chunks":
      case "subagent/descriptor":
      case "agent/inbox/spliced":
      case "agent-preset/selected":
      case "request/header":
      case "request/context":
      case "tool/code-dispatch":
      case "tool/code-dispatch-start":
        // recorded but not mapped to Memmy memory directly
        break;
      default:
        // unknown future event types are tolerated (forward-compatible)
        break;
    }
  }

  return {
    header,
    turns: [...turns.values()].sort((a, b) => a.turn - b.turn),
    maxSeq,
    totalEvents: lines.length - 1,
    skippedCorrupt,
  };
}

export function parseDshSessionBuffer(
  buffer: Buffer,
  options: ParseOptions = {},
): ParsedDshSession {
  let lines: string[];
  if (isZstdBuffer(buffer)) {
    const decoded = decompressZstdFrames(buffer);
    lines = decoded.lines;
  } else {
    lines = buffer.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
  }
  return parseDshSessionLines(lines, options);
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function currentTurn(turns: Map<number, DshTurn>, seq: number): DshTurn | undefined {
  let best: DshTurn | undefined;
  for (const turn of turns.values()) {
    if (turn.startSeq <= seq && (turn.endSeq === undefined || seq <= turn.endSeq)) {
      if (!best || turn.startSeq > best.startSeq) best = turn;
    }
  }
  return best;
}

function findToolCall(turns: Map<number, DshTurn>, callId: string): DshToolCall | undefined {
  for (const turn of turns.values()) {
    const found = turn.toolCalls.find((call) => call.callId === callId);
    if (found) return found;
  }
  return undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (isRecord(part) && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}
