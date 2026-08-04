import { Mail } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type Integration = {
  name: string;
  icon: LucideIcon;
  connected: boolean;
};

/** Icon lookup for connectors the backend may expose. */
const ICONS: Record<string, LucideIcon> = {
  Gmail: Mail,
};

export function integrationIcon(name: string): LucideIcon {
  return ICONS[name] ?? Mail;
}

export function watchingLabel(names: string[]): string {
  if (names.length === 0) return "No connectors yet";
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return `Watching ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
}
