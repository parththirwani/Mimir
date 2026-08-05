import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export type Credentials = z.infer<typeof credentialsSchema>;

export const messageSchema = z.object({
  conversationId: z.string().uuid(),
  content: z.string().min(1),
  clientMessageId: z.string().uuid(),
});

export type MessageRequest = z.infer<typeof messageSchema>;

// User-supplied MCP server registration (5.8). Transport is streamable-HTTP
// only — stdio is deliberately not offered for user-added servers.
export const mcpServerSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export type McpServerRequest = z.infer<typeof mcpServerSchema>;
