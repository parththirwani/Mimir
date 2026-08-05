export interface User {
  id: string;
  email: string;
  displayName: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  durationMs?: number | null;
}

export interface Conversation {
  id: string;
  title: string | null;
  messages: Message[];
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  model: string;
  latencyMs: number;
  usage: ChatUsage;
  actualModel?: string;
  finishReason?: string;
  cachedTokens?: number;
  generationId?: string;
  toolCalls?: { id: string; type: string; function: { name: string; arguments: string } }[];
}

export type LlmMessageRole = "system" | "user" | "assistant" | "tool";

export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
  toolCalls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  toolCallId?: string;
}
