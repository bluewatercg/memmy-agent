// DSH source adapter: discover DSH session artifacts, parse them, and import
// user turns / tool calls into Memmy memories with idempotent keys.
// See design §8 Phase 1.
import { open } from "node:fs/promises";
import type { Repositories } from "../../../storage/repositories.js";
import type { MemoryAddRequest } from "../../../types.js";
import { redactSensitiveText } from "../../../utils/sensitive-data.js";
import { nowIso } from "../../../utils/time.js";
import { discoverDshSessions, dshSessionsRoot, type DshSessionFile } from "./session-discovery.js";
import { DshImportState } from "./import-state.js";
import { decompressZstdFrames } from "./zstd-decoder.js";
import { parseDshSessionLines, type DshTurn } from "./session-parser.js";

export const DSH_SOURCE = "deepseek_harness";
export const DSH_ADAPTER_ID = "agent-source:deepseek_harness";

export const DSH_DEFAULT_MAX_SESSIONS_PER_RUN = 100;
export const DSH_DEFAULT_MAX_TURNS_PER_SESSION = 100;
export const DSH_DEFAULT_MAX_SESSION_BYTES = 16 * 1024 * 1024;
export const DSH_DEFAULT_MAX_SESSION_TOKENS = 100_000;

export interface DshImportOptions {
  root?: string;
  maxSessionsPerRun?: number;
  maxTurnsPerSession?: number;
  maxSessionBytes?: number;
  maxSessionTokens?: number;
}

export interface DshImportResult {
  sessionsSeen: number;
  sessionsImported: number;
  sessionsSkipped: number;
  turnsImported: number;
  memoriesWritten: number;
  errors: Array<{ sessionId: string; message: string }>;
}

export interface DshImportDeps {
  repos: Repositories;
  /** Write one memory; returns the memory id. Injected by the caller (MemoryService.addMemory). */
  writeMemory: (request: MemoryAddRequest) => string;
  root?: string | (() => string);
}

export class DshImportService {
  private readonly state: DshImportState;
  private readonly root: () => string;
  private readonly writeMemory: (request: MemoryAddRequest) => string;

  constructor(private readonly deps: DshImportDeps) {
    this.state = new DshImportState(deps.repos);
    this.writeMemory = deps.writeMemory;
    const root = deps.root;
    this.root = typeof root === "function"
      ? root
      : typeof root === "string"
        ? () => root
        : () => dshSessionsRoot();
  }

  async importAll(options: DshImportOptions = {}): Promise<DshImportResult> {
    const boundedOptions: DshImportOptions = {
      ...options,
      maxSessionsPerRun: options.maxSessionsPerRun ?? DSH_DEFAULT_MAX_SESSIONS_PER_RUN,
      maxTurnsPerSession: options.maxTurnsPerSession ?? DSH_DEFAULT_MAX_TURNS_PER_SESSION,
      maxSessionBytes: options.maxSessionBytes ?? DSH_DEFAULT_MAX_SESSION_BYTES,
      maxSessionTokens: options.maxSessionTokens ?? DSH_DEFAULT_MAX_SESSION_TOKENS,
    };
    const result: DshImportResult = {
      sessionsSeen: 0, sessionsImported: 0, sessionsSkipped: 0,
      turnsImported: 0, memoriesWritten: 0, errors: [],
    };
    const files = await discoverDshSessions(boundedOptions.root ? dshSessionsRoot(boundedOptions.root) : this.root());
    result.sessionsSeen = files.length;
    for (const file of files) {
      if (result.sessionsImported >= boundedOptions.maxSessionsPerRun!) break;
      try {
        const outcome = await this.importSession(file, boundedOptions);
        if (outcome.status === "imported") result.sessionsImported += 1;
        if (outcome.status === "skipped") result.sessionsSkipped += 1;
        result.turnsImported += outcome.turnsImported;
        result.memoriesWritten += outcome.memoriesWritten;
      } catch (error) {
        result.errors.push({ sessionId: file.sessionId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  private async importSession(file: DshSessionFile, options: DshImportOptions): Promise<{ status: "imported" | "skipped"; turnsImported: number; memoriesWritten: number }> {
    const at = nowIso();
    const claim = this.state.getClaim(file.sessionId);
    if (claim && claim.channel === "realtime" && claim.expiresAt > at) return { status: "skipped", turnsImported: 0, memoriesWritten: 0 };
    if (this.state.claim(file.sessionId, "historical", "dsh-import-service") === "existing") return { status: "skipped", turnsImported: 0, memoriesWritten: 0 };
    try {
      const previous = this.state.getCheckpoint(file.path);
      const reset = !previous || file.size < previous.frameEndOffset || previous.mtimeMs > file.mtimeMs;
      const start = reset ? 0 : previous.frameEndOffset;
      const remaining = Math.max(0, file.size - start);
      const length = Math.min(remaining, options.maxSessionBytes ?? Number.MAX_SAFE_INTEGER);
      const handle = await open(file.path, "r");
      let buffer = Buffer.alloc(length);
      try {
        if (length > 0) await handle.read(buffer, 0, length, start);
        // A compressed frame is atomic. A byte budget may cut through its
        // payload, so extend this one read through the available tail rather
        // than retrying an undecodable prefix forever.
        if (file.compression === "zstd" && length < remaining) {
          buffer = Buffer.alloc(remaining);
          await handle.read(buffer, 0, remaining, start);
        }
      } finally {
        await handle.close();
      }
      const decoded = file.compression === "zstd"
        ? decompressZstdFrames(buffer)
        : decodePlainJsonl(buffer);
      if (decoded.lines.length === 0 && !reset) return { status: "skipped", turnsImported: 0, memoriesWritten: 0 };
      const headerLine = reset ? decoded.lines[0] : previous?.headerLine;
      if (!headerLine) throw new Error("dsh session checkpoint missing header");
      const parsed = parseDshSessionLines(reset ? decoded.lines : [headerLine, ...decoded.lines], {
        maxEvents: options.maxSessionTokens ? Math.max(1, options.maxSessionTokens * 4) : undefined,
        initialTurns: reset ? undefined : previous?.incompleteTurns,
      });
      const tokenBudgetExceeded = Boolean(options.maxSessionTokens && decoded.lines.join("\n").length > options.maxSessionTokens * 4);
      if (tokenBudgetExceeded) parsed.turns.push({ turn: -1, startSeq: parsed.maxSeq, userMessages: [{ seq: parsed.maxSeq, text: `[DSH history truncated: token budget ${options.maxSessionTokens} exceeded]` }], toolCalls: [], startedAt: Date.now(), complete: true });
      const turns = parsed.turns.filter((turn) => turn.complete && (previous?.lastImportedTurn === undefined || turn.turn > previous.lastImportedTurn));
      const boundedTurns = options.maxTurnsPerSession ? turns.slice(0, options.maxTurnsPerSession) : turns;
      let memories = 0;
      for (const turn of boundedTurns) memories += this.importTurn(file, turn);
      const lastImportedTurn = boundedTurns.at(-1)?.turn ?? previous?.lastImportedTurn;
      const hasPendingTurns = boundedTurns.length < turns.length;
      this.state.saveCheckpoint({
        sourcePath: file.path,
        frameEndOffset: hasPendingTurns ? (previous?.frameEndOffset ?? start) : start + decoded.lastCompleteFrameEnd,
        lastFrameIndex: hasPendingTurns ? (previous?.lastFrameIndex ?? -1) : (reset ? -1 : previous?.lastFrameIndex ?? -1) + decoded.completeFrames,
        mtimeMs: file.mtimeMs,
        lastSeq: parsed.maxSeq,
        lastEventId: "",
        status: hasPendingTurns || decoded.skippedTail || start + decoded.lastCompleteFrameEnd < file.size ? "partial" : "complete",
        headerLine,
        incompleteTurns: parsed.turns.filter((turn) => !turn.complete),
        lastImportedTurn,
        updatedAt: at,
      });
      return { status: "imported", turnsImported: boundedTurns.length, memoriesWritten: memories };
    } finally {
      this.state.release(file.sessionId, "dsh-import-service");
    }
  }

  private importTurn(file: DshSessionFile, turn: DshTurn): number {
    let written = 0;
    const sessionId = file.sessionId;
    const sessionKey = `${DSH_SOURCE}:${sessionId}`;
    const turnKey = `${sessionKey}:turn:${turn.turn}`;

    for (const msg of turn.userMessages) {
      if (!msg.text.trim()) continue;
      const eventKey = `${sessionKey}:event:${msg.id ?? msg.seq}`;
      this.writeMemory({
        requestId: eventKey,
        adapterId: DSH_ADAPTER_ID,
        source: DSH_SOURCE,
        content: redactSensitiveText(msg.text),
        title: `DSH turn ${turn.turn} user`,
        turnId: `${turnKey}:user:${msg.seq}`,
        tags: [DSH_SOURCE, "agent-source", "dsh-user-message"],
        deferProcessing: true,
      });
      written += 1;
    }

    for (const call of turn.toolCalls) {
      if (!call.name) continue;
      const eventKey = `${sessionKey}:tool:${call.callId}`;
      const summary = `tool ${call.name} args=${truncate(call.arguments, 500)}`;
      this.writeMemory({
        requestId: eventKey,
        adapterId: DSH_ADAPTER_ID,
        source: DSH_SOURCE,
        content: redactSensitiveText(summary),
        title: `DSH turn ${turn.turn} tool ${call.name}`,
        layer: "L1",
        turnId: `${turnKey}:tool:${call.seq}`,
        tags: [DSH_SOURCE, "agent-source", "dsh-tool-call"],
        deferProcessing: true,
      });

      written += 1;
    }
    return written;
  }
}
function decodePlainJsonl(buffer: Buffer): { lines: string[]; completeFrames: number; lastCompleteFrameEnd: number; skippedTail: boolean } {
  const text = buffer.toString("utf8");
  const newline = text.lastIndexOf("\n");
  if (newline < 0) return { lines: [], completeFrames: 0, lastCompleteFrameEnd: 0, skippedTail: buffer.length > 0 };
  const completeText = text.slice(0, newline);
  return {
    lines: completeText.split("\n").filter((line) => line.trim().length > 0),
    completeFrames: 1,
    lastCompleteFrameEnd: Buffer.byteLength(text.slice(0, newline + 1), "utf8"),
    skippedTail: newline + 1 < text.length,
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "..." : value;
}
