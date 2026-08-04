import type { ComponentType, SVGProps } from "react";

export type Integration = {
  name: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  connected: boolean;
};

export function watchingLabel(names: string[]): string {
  if (names.length === 0) return "No connectors yet";
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return `Watching ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
}
