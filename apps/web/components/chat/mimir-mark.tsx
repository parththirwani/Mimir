import Image from "next/image";
import { cn } from "@/lib/utils";

/** The Mimir logo. */
export function MimirMark({ className }: { className?: string | undefined }) {
  return (
    <Image
      src="/logo.png"
      alt=""
      aria-hidden
      width={20}
      height={20}
      className={cn("size-5 -translate-y-1 rounded-full object-contain", className)}
    />
  );
}
