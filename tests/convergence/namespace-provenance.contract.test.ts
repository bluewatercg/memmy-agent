import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../Memory/tests/fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

describe("convergence: namespace and provenance", () => {
  it("keeps session, turn, and recall records isolated by workspace", async () => {
    const { db, service } = createTestService();
    const alpha = { source: "codex", profileId: "default", userId: "u", workspacePath: "/work/alpha" };
    const beta = { ...alpha, workspacePath: "/work/beta" };
    const first = service.openSession({ namespace: alpha, adapterId: "codex-hook", requestId: "alpha-open" });
    service.completeTurn("alpha-turn", {
      namespace: alpha, sessionId: first.sessionId, adapterId: "codex-hook", requestId: "alpha-complete",
      query: "alpha-only boundary", answer: "alpha result", provenance: { sourceAgent: "codex", requestId: "alpha-complete", gitRoot: "/work/alpha" }
    });
    const second = service.openSession({ namespace: beta, adapterId: "codex-hook", requestId: "beta-open" });
    const recall = await service.search({ namespace: beta, query: "alpha-only boundary", layers: ["L1"] });
    expect(recall.hits).toEqual([]);
    expect(() => service.closeSession(first.sessionId, { namespace: beta })).toThrow();
    expect(second.projectId).not.toBe(first.projectId);
    db.close();
  });
});
