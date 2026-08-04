import { Mail, Calendar, FileText, CircleDot, Github, Hash } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type Integration = {
  name: string;
  icon: LucideIcon;
  connected: boolean;
};

/** Same iconography as the landing page marquee. */
export const integrations: Integration[] = [
  { name: "Gmail", icon: Mail, connected: true },
  { name: "Calendar", icon: Calendar, connected: false },
  { name: "Notion", icon: FileText, connected: false },
  { name: "Linear", icon: CircleDot, connected: true },
  { name: "GitHub", icon: Github, connected: true },
  { name: "Slack", icon: Hash, connected: false },
];

export function watchingLabel(names: string[]): string {
  if (names.length === 0) return "No connectors yet";
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return `Watching ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
}
