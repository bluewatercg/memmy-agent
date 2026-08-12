/**
 * Contract test: .env.example must contain expected Memory configuration defaults.
 * Ensures new developers get correct default values for multi-agent topic decision.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

describe(".env.example contract", () => {
  it("contains MEMMY_TOPIC_DECISIONS_ENABLED=false in Memory section", () => {
    const envPath = join(process.cwd(), ".env.example");
    const content = readFileSync(envPath, "utf-8");

    // Must have the default disabled setting
    expect(content).toContain("MEMMY_TOPIC_DECISIONS_ENABLED=false");

    // Must have the default model list
    expect(content).toContain("MEMMY_TOPIC_DECISION_MODELS=MiniMax-M2.5,qwen3.7-plus,kimi-k2.5,glm-5");

    // Must be after EVOLUTION section (Memory config)
    const evolutionIndex = content.indexOf("MEMMY_EVOLUTION_TIMEOUT_MS");
    const topicIndex = content.indexOf("MEMMY_TOPIC_DECISIONS_ENABLED");
    expect(topicIndex).toBeGreaterThan(evolutionIndex);
  });
});