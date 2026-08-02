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
