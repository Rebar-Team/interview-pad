import { Brand } from "@/components/Brand";
import { Link } from "@/components/Link";
import { NewRoomDialog } from "@/components/NewRoomDialog";
import { RoomStatusBadge } from "@/components/RoomStatusBadge";
import { UserMenu } from "@/components/UserMenu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, type Me, type Room, roomUrl, useRooms } from "@/lib/api";
import { navigate } from "@/lib/router";
import { formatDuration, formatRelative, useNow } from "@/lib/time";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Link2, MonitorPlay } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type Scope = "mine" | "all";

async function copyLink(room: Room) {
  await navigator.clipboard.writeText(roomUrl(room.id));
  toast.success("Link copied", {
    description: "Send it to your candidate.",
  });
}

function EmptyState({ scope }: { scope: Scope }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted">
        <MonitorPlay className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">No rooms yet</p>
        <p className="text-sm text-muted-foreground">
          {scope === "mine"
            ? "Create a room and share the link with your candidate."
            : "Nobody on the team has created a room yet."}
        </p>
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

export default function Dashboard({ me }: { me: Me }) {
  const [scope, setScope] = useState<Scope>("mine");
  const rooms = useRooms();
  const now = useNow();
  const queryClient = useQueryClient();

  // A session that expires while the dashboard is open goes back to sign-in.
  const signedOut =
    rooms.error instanceof ApiError && rooms.error.status === 401;
  useEffect(() => {
    if (signedOut) void queryClient.invalidateQueries({ queryKey: ["me"] });
  }, [signedOut, queryClient]);

  const visible =
    rooms.data?.filter(
      (room) => scope === "all" || room.createdBy === me.email,
    ) ?? [];

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <Brand />
          <UserMenu me={me} />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Rooms</h1>
            <p className="text-sm text-muted-foreground">
              Rooms stay editable for {formatDuration(me.roomTtlMs)}, then
              become read-only.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)}>
              <TabsList>
                <TabsTrigger value="mine">Mine</TabsTrigger>
                <TabsTrigger value="all">All team</TabsTrigger>
              </TabsList>
            </Tabs>
            <NewRoomDialog ttlMs={me.roomTtlMs} />
          </div>
        </div>

        {rooms.isPending ? (
          <LoadingRows />
        ) : rooms.isError && !rooms.data ? (
          <p className="text-sm text-destructive">
            Couldn't load rooms: {rooms.error.message}
          </p>
        ) : visible.length === 0 ? (
          <EmptyState scope={scope} />
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Name</TableHead>
                  <TableHead>Created by</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-4 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((room) => (
                  <TableRow
                    key={room.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/r/${room.id}`)}
                  >
                    <TableCell className="pl-4 font-medium">
                      {room.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {room.createdBy === me.email ? "You" : room.createdBy}
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground"
                      title={new Date(room.createdAt).toLocaleString()}
                    >
                      {formatRelative(room.createdAt, now)}
                    </TableCell>
                    <TableCell>
                      <RoomStatusBadge
                        expiresAt={room.expiresAt}
                        writable={room.writable}
                        now={now}
                      />
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <div
                        className="flex justify-end gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyLink(room)}
                        >
                          <Link2 />
                          Copy link
                        </Button>
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/r/${room.id}`}>
                            Open
                            <ArrowUpRight />
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </main>
    </div>
  );
}
