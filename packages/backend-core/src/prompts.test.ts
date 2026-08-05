import { describe, expect, test } from "bun:test";
import { chatSystemPrompt, executionSystemPrompt, loadPrompt } from "./prompts.js";

describe("prompt loader", () => {
  test("loads a raw prompt file from disk", () => {
    const system = loadPrompt("system.md");
    expect(system).toContain("Mimir");
    expect(system.length).toBeGreaterThan(1000);
  });

  test("chatSystemPrompt composes the Interaction Agent persona from all 5 files", () => {
    const p = chatSystemPrompt();
    expect(p).toContain("You are Mimir"); // system.md
    expect(p).toContain("wait` tool"); // rules.md
    expect(p).toContain("SOC 2 Type II"); // integrations.md
    expect(p).toContain("28_view-email"); // email.md
    expect(p).toContain("Memory and Context"); // meomery.md
  });

  test("executionSystemPrompt injects the concrete task", () => {
    const p = executionSystemPrompt({ task: "watch for urgent email", context: "ping me when", contextSummary: "so far: nothing" });
    expect(p).toContain("execution engine");
    expect(p).toContain("watch for urgent email");
    expect(p).toContain("ping me when");
    expect(p).toContain("so far: nothing");
  });
});
