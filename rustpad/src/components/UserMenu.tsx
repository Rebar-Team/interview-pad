import { type Me, api } from "@/lib/api";
import { toggleTheme, useTheme } from "@/lib/theme";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Moon, Sun } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join("") || "?"
  );
}

export function UserMenu({ me }: { me: Me }) {
  const theme = useTheme();
  const queryClient = useQueryClient();

  async function signOut() {
    try {
      await api.logout();
    } catch (e) {
      toast.error("Couldn't sign out", { description: (e as Error).message });
      return;
    }
    queryClient.clear();
    window.location.href = "/";
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label="Account"
      >
        <Avatar>
          {me.picture && (
            <AvatarImage src={me.picture} alt="" referrerPolicy="no-referrer" />
          )}
          <AvatarFallback>{initials(me.name)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">{me.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {me.email}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={toggleTheme}>
          {theme === "dark" ? <Sun /> : <Moon />}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={signOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
