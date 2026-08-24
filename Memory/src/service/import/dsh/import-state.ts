// Import checkpoints and session claims for the DSH source adapter.
// Stored in runtime_kv under reserved key prefixes (see design §6.2/§7).
import type { DshTurn } from "./session-parser.js";
import type { Repositories } from "../../../storage/repositories.js";

const CLAIM_PREFIX = "dsh:claim:";
const CHECKPOINT_PREFIX = "dsh:checkpoint:";
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000; // 24h default

export interface DshClaim {
  channel: "realtime" | "historical";
  claimedAt: string;
  owner: string;
  expiresAt: string;
}

export interface DshImportCheckpoint {
  sourcePath: string;
  frameEndOffset: number;
  lastFrameIndex: number;
  mtimeMs: number;
  lastSeq: number;
  lastEventId: string;
  status: "complete" | "partial" | "corrupt";
  error?: string;
  headerLine?: string;
  incompleteTurns?: DshTurn[];
  lastImportedTurn?: number;
  updatedAt: string;
}

export class DshImportState {
  constructor(private readonly repos: Repositories) {}

  claimKey(sessionId: string): string {
    return CLAIM_PREFIX + sessionId;
  }

  checkpointKey(sourcePath: string): string {
    return CHECKPOINT_PREFIX + sourcePath;
  }

  /** CAS claim: inserts only if absent (or existing claim expired). */
  claim(sessionId: string, channel: "realtime" | "historical", owner: string): "acquired" | "existing" | "expired-replaced" {
    const key = this.claimKey(sessionId);
    const now = new Date();
    const at = now.toISOString();
    const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
    const existing = this.repos.runtime.getKv(key);
    if (existing) {
      const claim = existing.value as DshClaim | undefined;
      const active = claim?.channel === "realtime" || claim?.channel === "historical";
      if (claim && active && claim.expiresAt > at) return "existing";
      const replaced = this.repos.runtime.setKvIfValue(
        key,
        existing.value,
        { channel, claimedAt: at, owner, expiresAt },
        at,
      );
      return replaced ? "expired-replaced" : "existing";
    }
    const inserted = this.repos.runtime.setKvIfAbsent(key, { channel, claimedAt: at, owner, expiresAt }, at);
    return inserted ? "acquired" : "existing";
  }

  renew(sessionId: string, owner: string): boolean {
    const key = this.claimKey(sessionId);
    const existing = this.repos.runtime.getKv(key);
    if (!existing) return false;
    const claim = existing.value as DshClaim | undefined;
    if (!claim || claim.owner !== owner) return false;
    const at = new Date();
    const expiresAt = new Date(at.getTime() + CLAIM_TTL_MS).toISOString();
    return this.repos.runtime.setKvIfValue(
      key,
      existing.value,
      { ...claim, expiresAt },
      at.toISOString(),
    );
  }

  release(sessionId: string, owner: string): boolean {
    const key = this.claimKey(sessionId);
    const existing = this.repos.runtime.getKv(key);
    if (!existing) return false;
    const claim = existing.value as DshClaim | undefined;
    if (!claim || claim.owner !== owner) return false;
    return this.repos.runtime.setKvIfValue(
      key,
      existing.value,
      { ...claim, channel: "released" },
      new Date().toISOString(),
    );
  }

  getClaim(sessionId: string): DshClaim | undefined {
    const existing = this.repos.runtime.getKv(this.claimKey(sessionId));
    return existing?.value as DshClaim | undefined;
  }

  /** Reap expired claims; returns count reclaimed. */
  reapExpired(now = new Date().toISOString()): number {
    let reclaimed = 0;
    for (const key of this.listClaimKeys()) {
      const existing = this.repos.runtime.getKv(key);
      const claim = existing?.value as Record<string, unknown> | undefined;
      const channel = typeof claim?.channel === "string" ? claim.channel : undefined;
      const expiresAt = typeof claim?.expiresAt === "string" ? claim.expiresAt : undefined;
      if (claim && channel !== "released" && expiresAt !== undefined && expiresAt <= now) {
        this.repos.runtime.setKv(key, { ...claim, channel: "expired" }, now);
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  private listClaimKeys(): string[] {
    return this.repos.runtime.listKvKeys(CLAIM_PREFIX);
  }

  saveCheckpoint(checkpoint: DshImportCheckpoint): void {
    this.repos.runtime.setKv(this.checkpointKey(checkpoint.sourcePath), checkpoint, checkpoint.updatedAt);
  }

  getCheckpoint(sourcePath: string): DshImportCheckpoint | undefined {
    const existing = this.repos.runtime.getKv(this.checkpointKey(sourcePath));
    return existing?.value as DshImportCheckpoint | undefined;
  }
}
