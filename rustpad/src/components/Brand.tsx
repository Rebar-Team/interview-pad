import { cn } from "@/lib/utils";

import { Link } from "./Link";

export function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn("flex items-center gap-1.5 select-none", className)}
      aria-label="RebarPad home"
    >
      <img src="/rebar-logo.svg" alt="Rebar" className="h-[18px] dark:invert" />
      <span className="text-lg font-semibold tracking-tight">Pad</span>
    </Link>
  );
}
