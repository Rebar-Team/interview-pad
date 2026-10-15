import { api } from "@/lib/api";
import { navigate } from "@/lib/router";
import { formatDuration } from "@/lib/time";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dices, Loader2, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function NewRoomDialog({ ttlMs }: { ttlMs: number }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const reroll = useMutation({
    mutationFn: api.gamertag,
    onSuccess: (data) => setName(data.name),
  });

  const create = useMutation({
    mutationFn: () => api.createRoom(name.trim()),
    onSuccess: (room) => {
      queryClient.invalidateQueries({ queryKey: ["rooms"] });
      setOpen(false);
      navigate(`/r/${room.id}`);
    },
    onError: (e) => toast.error(e.message),
  });

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setName("");
      reroll.mutate();
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!create.isPending) create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          New room
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>New room</DialogTitle>
            <DialogDescription>
              The room is editable for {formatDuration(ttlMs)}, then locks as a
              read-only record of the interview.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="room-name">Name</Label>
            <div className="flex gap-2">
              <Input
                id="room-name"
                autoFocus
                maxLength={80}
                placeholder={
                  reroll.isPending ? "Rolling a name..." : "Room name"
                }
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Random name"
                title="Random name"
                disabled={reroll.isPending}
                onClick={() => reroll.mutate()}
              >
                <Dices />
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2 className="animate-spin" />}
              Create room
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
