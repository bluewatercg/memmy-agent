// DSH source adapter: discover DSH session artifacts, parse them, and import
// user turns / tool calls into Memmy memories with idempotent keys.
// See design §8 Phase 1.
import type { Repositories } from "../../../storage/repositories.js";
import type { MemoryAddRequest } from "../../../types.js";
import { redactSensitiveText } from "../../../utils/sensitive-data.js";
import { nowIso } from "../../../utils/time.js";
import { discoverDshSessions, readDshSessionFile, dshSessionsRoot, type DshSessionFile } from "./session-discovery.js";
import { DshImportState } from "./import-state.js";
import type { DshTurn } from "./session-parser.js";

export const DSH_SOURCE = "deepseek_harness";
export const DSH_ADAPTER_ID = "agent-source:deepseek_harness";

export interface DshImportOptions {
  root?: string;
  maxSessionsPerRun?: number;
  maxTurnsPerSession?: number;
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
    const result: DshImportResult = {
      sessionsSeen: 0, sessionsImported: 0, sessionsSkipped: 0,
      turnsImported: 0, memoriesWritten: 0, errors: [],
    };
    const files = await discoverDshSessions(this.root());
    result.sessionsSeen = files.length;

    for (const file of files) {
      if (options.maxSessionsPerRun && result.sessionsImported >= options.maxSessionsPerRun) break;
      try {
        const outcome = await this.importSession(file, options);
        if (outcome === "imported") result.sessionsImported += 1;
        if (outcome === "skipped") result.sessionsSkipped += 1;
      } catch (error) {
        result.errors.push({
          sessionId: file.sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  private async importSession(file: DshSessionFile, options: DshImportOptions): Promise<"imported" | "skipped"> {
    const at = nowIso();
    const claim = this.state.getClaim(file.sessionId);
    if (claim && claim.channel === "realtime" && claim.expiresAt > at) {
      return "skipped"; // realtime owns live sessions
    }

    const claimOutcome = this.state.claim(file.sessionId, "historical", "dsh-import-service");
    if (claimOutcome === "existing") {
      return "skipped"; // another importer active
    }

    const { parsed } = await readDshSessionFile(file);
    let turns = parsed.turns;
    if (options.maxTurnsPerSession) turns = turns.slice(0, options.maxTurnsPerSession);

    let memories = 0;
    for (const turn of turns) {
      memories += this.importTurn(file, turn);
    }

    this.state.saveCheckpoint({
      sourcePath: file.path,
      frameEndOffset: file.size,
      lastFrameIndex: -1,
      mtimeMs: file.mtimeMs,
      lastSeq: parsed.maxSeq,
      lastEventId: "",
      status: "complete",
      updatedAt: at,
    });
    void memories;
    return "imported";
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
        layer: "L1",
        sessionId: `dsh-session-${sessionId}`,
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
        sessionId: `dsh-session-${sessionId}`,
        turnId: `${turnKey}:tool:${call.seq}`,
        tags: [DSH_SOURCE, "agent-source", "dsh-tool-call"],
        deferProcessing: true,
      });
      written += 1;
    }
    return written;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "..." : value;
}
