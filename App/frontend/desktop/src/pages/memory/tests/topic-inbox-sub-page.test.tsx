// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopicInboxSubPage } from "../topic-inbox-sub-page.js";
import { createMockMemoryRuntimeClient } from "./memory-runtime-fixtures.js";

const now = "2026-08-11T12:00:00.000Z";
function topic() {
  return { id: "topic-1", title: "Migration recovery", summary: "Configuration, failure, fix and verification", status: "active" as const, version: 2, evidenceCount: 4, candidateCounts: { pending: 1, approved: 0, rejected: 0, deferred: 0, superseded: 0 }, candidates: [{ id: "candidate-1", topicId: "topic-1", title: "Recovery policy", conclusion: "Validate configuration after migration", proposedLayer: "L3" as const, status: "pending" as const, version: 1, evidenceCount: 4, updatedAt: now }], updatedAt: now };
}

describe("TopicInboxSubPage", () => {
  let host: HTMLDivElement; let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

  it("keeps candidates and raw evidence collapsed until requested", async () => {
    const client = createMockMemoryRuntimeClient();
    client.listTopicInbox = vi.fn(async (input) => ({ projects: [{ namespace: input.namespace, projectId: "project-1", topics: [topic()] }], serverTime: now }));
    client.topicEvidence = vi.fn(async () => ({ topicId: "topic-1", items: [{ id: "e-1", memoryId: "m-1", role: "verification", summary: "Passed", rawText: "raw trace", createdAt: now }], total: 1, limit: 20, serverTime: now }));
    await act(async () => root.render(<TopicInboxSubPage client={client} projects={[{ id: "project-1", name: "Project One" }]} />));
    await act(async () => undefined);
    expect(host.textContent).toContain("Migration recovery");
    expect(client.topicEvidence).not.toHaveBeenCalled();
    await act(async () => button("Expand Migration recovery").click());
    expect(host.textContent).not.toContain("raw trace");
    await act(async () => textButton("Show raw evidence").click());
    expect(client.topicEvidence).toHaveBeenCalledWith("topic-1", expect.objectContaining({ limit: 20 }));
    expect(host.textContent).toContain("raw trace");
  });

  it("routes approve and reloads after optimistic conflicts", async () => {
    const client = createMockMemoryRuntimeClient();
    client.listTopicInbox = vi.fn(async (input) => ({ projects: [{ namespace: input.namespace, projectId: "project-1", topics: [topic()] }], serverTime: now }));
    client.decideTopicCandidate = vi.fn(async () => { throw new Error("topic candidate version conflict"); });
    await act(async () => root.render(<TopicInboxSubPage client={client} projects={[{ id: "project-1", name: "Project One" }]} />));
    await act(async () => undefined);
    await act(async () => button("Expand Migration recovery").click());
    await act(async () => textButton("Approve").click());
    expect(client.decideTopicCandidate).toHaveBeenCalledWith("candidate-1", expect.objectContaining({ action: "approve", expectedVersion: 1 }));
    expect(client.listTopicInbox).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("version conflict");
  });
});
function button(label: string) { return hostButton((item) => item.getAttribute("aria-label") === label); }
function textButton(text: string) { return hostButton((item) => item.textContent?.includes(text) === true); }
function hostButton(predicate: (button: HTMLButtonElement) => boolean) { const result = [...document.querySelectorAll("button")].find((item) => predicate(item)); if (!result) throw new Error("button not found"); return result; }
