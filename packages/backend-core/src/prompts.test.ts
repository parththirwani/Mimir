import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.JWT_SECRET = "prompts-test-secret";

const { chatSystemPrompt, executionSystemPrompt, loadPrompt } = await import("./prompts.js");

describe("prompt loader", () => {
  test("loads a raw prompt file from disk", () => {
    const system = loadPrompt("system.md");
    expect(system).toContain("Mimir");
    expect(system.length).toBeGreaterThan(1000);
  });

  test("chatSystemPrompt composes the Interaction Agent persona from all 6 files", () => {
    const p = chatSystemPrompt();
    expect(p).toContain("You are Mimir"); // system.md
    expect(p).toContain("wait` tool"); // rules.md
    expect(p).toContain("SOC 2 Type II"); // integrations.md
    expect(p).toContain("28_view-email"); // email.md
    expect(p).toContain("Memory and Context"); // meomery.md
    expect(p).toContain("You have NO agent, search"); // chat_no_tools.md
  });

  test("executionSystemPrompt injects the concrete task", () => {
    const p = executionSystemPrompt({ task: "watch for urgent email", context: "ping me when", contextSummary: "so far: nothing" });
    expect(p).toContain("execution engine");
    expect(p).toContain("watch for urgent email");
    expect(p).toContain("ping me when");
    expect(p).toContain("so far: nothing");
    expect(p).toContain("Report ONLY facts"); // execution_facts.md
  });
});

describe("surface prompt files", () => {
  const expectedFiles = [
    "ack.md",
    "chat_no_tools.md",
    "execution_facts.md",
    "summarize_events.md",
    "filter_agent.md",
    "filter_email.md",
    "trigger_eval.md",
    "classification.md",
    "trigger_extract.md",
    "email_propose.md",
    "email_resolve.md",
    "agent_draft_resolve.md",
    "surface.md",
  ];

  for (const f of expectedFiles) {
    test(`${f} loads non-empty`, () => {
      const c = loadPrompt(f);
      expect(c.trim().length).toBeGreaterThan(10);
    });
  }

  test("surface.md contains the no-leak rule", () => {
    expect(loadPrompt("surface.md")).toMatch(/never reveal.*agents[\s\S]*integrations/i);
  });

  test("chat_no_tools.md forbids tool calls", () => {
    expect(loadPrompt("chat_no_tools.md")).toContain("You have NO agent, search");
  });
});

describe("prompt consolidation (all prompts live in the folder)", () => {
  const sourceFiles = [
    "../../apps/api/src/agent/agent.ts",
    "../../apps/api/src/agent/agent-draft.ts",
    "../../apps/api/src/email/email-action.ts",
    "../../apps/worker/src/agent/agent-execution.ts",
    "../../apps/worker/src/agent/trigger-eval.ts",
    "src/ack.ts",
  ];

  // Flag inline prompt literals that should live in packages/backend-core/src/prompts/*.md
  const inlinePromptPatterns = [
    /const [A-Z_]+_SYSTEM\s*=\s*\[/,
    /\b(role:\s*"system",\s*content\s*:\s*)"(You (are|judge|extract|write|decide)|Respond with STRICT JSON|Decide\b|Summarize\b)/,
    /"Never mention internal tools/,
    /"Report ONLY facts present/,
  ];

  for (const file of sourceFiles) {
    test(`${file} has no inline LLM system prompts`, async () => {
      const src = await Bun.file(file).text();
      for (const re of inlinePromptPatterns) {
        expect(src, `${file} matched ${re}`).not.toMatch(re);
      }
      // ACK_SYSTEM etc. may still be a constant name; ensure it reads from loadPrompt.
      expect(src, `${file} references loadPrompt`).toMatch(/loadPrompt/);
    });
  }
});
