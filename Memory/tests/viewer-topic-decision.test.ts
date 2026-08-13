import { describe, expect, it } from "vitest";
import { memoryPanelHtml } from "../src/viewer/static.js";

describe("topic decision console", () => {
  it("puts summary and proposals before collapsed debate details", () => {
    const html = memoryPanelHtml();
    expect(html).toContain("Decision summary");
    expect(html).toContain("At most three proposal cards");
    expect(html.indexOf("Decision summary")).toBeLessThan(html.indexOf("Debate details"));
  });

  it("renders blocked questions instead of an approval action", () => {
    const html = memoryPanelHtml();
    expect(html).toContain("Missing information");
    expect(html).toContain("Submit answers");
    expect(html).toContain("Unresolved high-risk disagreement");
  });

  it("requires explicit first and second confirmation clicks for irreversible effects", () => {
    const html = memoryPanelHtml();
    expect(html).toContain("Awaiting confirmation");
    expect(html).toContain("Resume execution");
    expect(html).toContain("confirmExecution");
    expect(html).toContain("confirmationCheckpoint");
    expect(html).toMatch(/first confirmation|First confirmation/i);
    expect(html).toMatch(/second confirmation|Second confirmation/i);
  });

  it("does not wire proposal approval to execution without a separate click", () => {
    const html = memoryPanelHtml();
    expect(html).toContain("Approve proposal");
    expect(html).toContain("execution route");
    expect(html).toContain("explicit click");
  });
});
