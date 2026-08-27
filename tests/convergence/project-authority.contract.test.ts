import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../Memory/tests/fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

describe("convergence: project authority", () => {
  it("requires explicit approval and scopes the active goal and focus", async () => {
    const { db, service } = createTestService();
    const namespace = { source: "codex", profileId: "default", userId: "authority-user", workspacePath: "/work/authority" };
    const candidate = service.proposeProjectGoal({ namespace, title: "Ship authority", summary: "Candidate", detail: "Explicit approval required" });
    expect(service.readProjectContext(namespace).activeGoal).toBeUndefined();
    const approved = service.approveProjectGoal({ namespace, candidateId: candidate.id });
    const work = service.createProjectWorkItem({ namespace, goalId: approved.id, title: "Verify", summary: "Verify authority", nextStep: "Run contract" });
    service.selectProjectWorkItem({ namespace, workItemId: work.id });
    const rendered = service.renderStableProjectContext(namespace);
    expect(rendered.status).toBe("ready");
    expect(rendered.goal?.id).toBe(approved.id);
    expect(rendered.focusedWorkItem?.id).toBe(work.id);
    const other = { ...namespace, workspacePath: "/work/other" };
    const otherSession = service.openSession({ namespace: other });
    expect((await service.startTurn({ namespace: other, sessionId: otherSession.sessionId, query: "unrelated" })).projectContext.status).toBe("no_confirmed_goal");
    db.close();
  });
});
