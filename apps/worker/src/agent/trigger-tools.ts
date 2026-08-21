import { getPrismaClient } from "@mimir/backend-core";
import type { Task, ToolContext } from "@mimir/tasks";

// Agent-facing Trigger CRUD exposed to Execution Agents (not the Interaction
// Agent). Ownership is scoped to the calling agent: every tool filters/creates
// on that agentId, so one agent can't touch another's triggers. The 1-min
// scheduler tick then fires matching triggers.
const prisma = getPrismaClient();

function scope(ctx: ToolContext): string {
  if (!ctx.agentId) throw new Error("trigger tools require an agent context");
  return ctx.agentId;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function triggerTools(): Task[] {
  return [
    {
      kind: "task",
      name: "create_trigger",
      description: "Create a recurring condition for this agent. `criteria` is a plain-description of when to wake the agent (e.g. \"when an urgent email from Alice arrives\"). Returns the new trigger.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short label for the trigger." },
          criteria: { type: "string", description: "Natural-language condition that causes the agent to run." },
        },
        required: ["criteria"],
      },
      async execute(input, ctx) {
        const agentId = scope(ctx);
        const criteria = text((input as { criteria?: unknown }).criteria);
        if (!criteria) throw new Error("create_trigger requires criteria");
        const name = text((input as { name?: unknown }).name) ?? "trigger";
        const created = await prisma.trigger.create({ data: { agentId, name, criteria } });
        return { id: created.id, name: created.name, criteria: created.criteria };
      },
    },
    {
      kind: "task",
      name: "list_triggers",
      description: "List this agent's triggers.",
      inputSchema: { type: "object", properties: {} },
      async execute(_input, ctx) {
        const triggers = await prisma.trigger.findMany({ where: { agentId: scope(ctx) }, select: { id: true, name: true, criteria: true, enabled: true } });
        return { triggers };
      },
    },
    {
      kind: "task",
      name: "update_trigger",
      description: "Update a trigger's criteria (or disable/enable it) by id.",
      inputSchema: {
        type: "object",
        properties: {
          triggerId: { type: "string" },
          criteria: { type: "string" },
          enabled: { type: "boolean" },
        },
        required: ["triggerId"],
      },
      async execute(input, ctx) {
        const agentId = scope(ctx);
        const triggerId = String((input as { triggerId?: unknown }).triggerId ?? "");
        const criteria = text((input as { criteria?: unknown }).criteria);
        const enabled = (input as { enabled?: unknown }).enabled;
        const owned = await prisma.trigger.findFirst({ where: { id: triggerId, agentId } });
        if (!owned) throw new Error("trigger not found for this agent");
        const updated = await prisma.trigger.update({
          where: { id: owned.id },
          data: { ...(criteria ? { criteria } : {}), ...(typeof enabled === "boolean" ? { enabled } : {}) },
        });
        return { id: updated.id, criteria: updated.criteria, enabled: updated.enabled };
      },
    },
    {
      kind: "task",
      name: "cancel_trigger",
      description: "Disable (soft-delete) one of this agent's triggers by id or name.",
      inputSchema: {
        type: "object",
        properties: {
          triggerId: { type: "string" },
          name: { type: "string" },
        },
      },
      async execute(input, ctx) {
        const agentId = scope(ctx);
        const triggerId = String((input as { triggerId?: unknown }).triggerId ?? "");
        const name = text((input as { name?: unknown }).name);
        const where: { agentId: string; id?: string; name?: string } = { agentId };
        if (triggerId) where.id = triggerId;
        else if (name) where.name = name;
        else throw new Error("cancel_trigger requires triggerId or name");
        const result = await prisma.trigger.updateMany({ where, data: { enabled: false } });
        return { cancelled: result.count };
      },
    },
  ];
}
