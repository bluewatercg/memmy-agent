import {
  policyMetaFromMemory,
  skillMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import type { MemoryRow } from "../../types.js";

export function isInactiveEvolutionMemory(memory: MemoryRow): boolean {
  if (memory.status === "archived" || memory.status === "deleted") return true;
  if (memory.memoryLayer === "L2") {
    return policyMetaFromMemory(memory)?.status === "archived";
  }
  if (memory.memoryLayer === "Skill") {
    return skillMetaFromMemory(memory)?.status === "archived";
  }
  return false;
}
