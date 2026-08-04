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
};

/** The one continuous thread. Same voice as the landing page. */
export const seedThread: ThreadMessage[] = [
  {
    id: "m1",
    speaker: "you",
    text: "Keep an eye on the Ridgeline contract. I'm waiting on their signature.",
    at: "Mon 9:12",
  },
  {
    id: "m2",
    speaker: "mimir",
    text: "Noted. I'll watch Gmail for anything from Ridgeline and tell you the moment it moves.",
    at: "Mon 9:12",
  },
  {
    id: "m3",
    speaker: "mimir",
    proactive: true,
    divider: "3 days later",
    text: "Ridgeline signed. It came in at 6:41 this morning from Dana, countersigned, no changes to the terms you flagged.",
    at: "Thu 6:44",
  },
  {
    id: "m4",
    speaker: "you",
    text: "Anything else stuck behind it?",
    at: "Thu 7:02",
  },
  {
    id: "m5",
    speaker: "mimir",
    text: "One thing. The Linear issue for their onboarding is still unassigned, and it was blocking the kickoff date you put in the calendar for Thursday.",
    at: "Thu 7:02",
  },
];
