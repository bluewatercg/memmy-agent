import { describe, expect, it } from "vitest";
import { createBuiltinAgentSourceRegistry } from "../builtin-agent-source-registry.js";

describe("built-in agent source registry", () => {
  it("exposes OMP and FreeBuff without duplicating the Pi-compatible runtime", () => {
    const registry = createBuiltinAgentSourceRegistry();

    expect(registry.list().map((adapter) => adapter.descriptor.sourceId)).toEqual([
      "cursor",
      "claude_code",
      "codex",
      "omp",
      "opencode",
      "openclaw",
      "hermes",
      "workbuddy",
      "freebuff"
    ]);
    expect(registry.get("pi")).toBeUndefined();
    expect(registry.require("omp").descriptor.displayName).toBe("OMP");
    expect(registry.require("freebuff").descriptor.displayName).toBe("FreeBuff");
  });
});
