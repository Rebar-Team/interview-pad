import { formatRemaining } from "@/lib/time";
import { Lock } from "lucide-react";

import { Badge } from "./ui/badge";

export function RoomStatusBadge({
  expiresAt,
  writable,
  now,
}: {
  expiresAt: number;
  writable: boolean;
  now: number;
}) {
  if (!writable || expiresAt <= now) {
    return (
      <Badge variant="secondary" className="text-muted-foreground">
        <Lock />
        Read-only
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    >
      <span className="size-1.5 rounded-full bg-current" />
      {formatRemaining(expiresAt, now)}
    </Badge>
  );
}
