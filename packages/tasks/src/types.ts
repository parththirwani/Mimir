import { z } from "zod";

// The atomic Tool / composite Task abstraction (plan 4.9).
//
// A Tool is ONE API call; a Task is a multi-step composite that returns one
// aggregated result (e.g. a search fanning across time windows). Both expose the
// same shape so the LLM sees them identically (name/description/inputSchema) and
// the runner treats them uniformly. MCP integrations wrap as Tasks (5.7/5.8).

export interface ToolContext {
  userId: string;
  agentId?: string;
}

// kind: "tool" = single call; "task" = composite, aggregated result. Structurally
// identical so both present to the model the same way; the discriminator is for
// the codebase's own reasoning + future registry UI.
//
// inputSchema accepts a zod schema OR a raw JSON Schema object. The raw form
// serves dynamic MCP tools (5.8), whose schemas come straight from the server's
// tools/list and shouldn't be round-tripped through zod.
export type InputSchema = z.ZodType | Record<string, unknown>;

export interface ToolDefinition {
  kind: "tool" | "task";
  name: string;
  description: string;
  inputSchema: InputSchema;
  execute(input: unknown, ctx: ToolContext): Promise<unknown>;
}

export type Tool = ToolDefinition & { kind: "tool" };
export type Task = ToolDefinition & { kind: "task" };

// Uniform error for tool/task failures — no bespoke per-integration mapping.
export type ToolErrorKind = "connection" | "execution" | "validation" | "unavailable" | "blocked";

export class ToolError extends Error {
  readonly kind: ToolErrorKind;
  constructor(kind: ToolErrorKind, message: string) {
    super(message);
    this.name = "ToolError";
    this.kind = kind;
  }
}

// Present any tool/task to the model as an OpenAI-compatible function schema.
// zod v4's toJSONSchema() emits standard JSON Schema; raw JSON Schema passes
// through untouched. Either form is what OpenRouter accepts.
export function toLlmTool(t: { name: string; description: string; inputSchema: InputSchema }): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
} {
  const isZod = typeof (t.inputSchema as z.ZodType).toJSONSchema === "function";
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: (isZod ? (t.inputSchema as z.ZodType).toJSONSchema() : (t.inputSchema as Record<string, unknown>)) as Record<string, unknown>,
    },
  };
}
