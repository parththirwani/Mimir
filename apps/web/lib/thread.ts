export type Speaker = "you" | "mimir";

export type ThreadMessage = {
  id: string;
  speaker: Speaker;
  text: string;
  /** Arrived unprompted — rendered under a time divider. */
  proactive?: boolean;
  /** Copy for the divider above a proactive message, e.g. "3 days later". */
  divider?: string;
  /** Display time, revealed on hover. */
  at?: string;
  /** A pending action (e.g. a gmail draft) awaits send/cancel approval. */
  actionable?: boolean;
  /** An integration connection (e.g. gmail) needs to be connected via a button. */
  connectable?: boolean;
};
