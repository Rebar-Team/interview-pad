import Terminal, { TerminalHandle, isRunnable } from "@/Terminal";
import animals from "@/animals.json";
import AssistantPanel from "@/assistant/AssistantPanel";
import { Brand } from "@/components/Brand";
import { NotFound } from "@/components/NotFound";
import { RoomStatusBadge } from "@/components/RoomStatusBadge";
import { initials } from "@/components/UserMenu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type Room, roomUrl, useRoom } from "@/lib/api";
import { toggleTheme, useTheme } from "@/lib/theme";
import { formatDuration, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import Rustpad, { type RoomStatus, type UserInfo } from "@/rustpad";
import Editor from "@monaco-editor/react";
import {
  Link2,
  Loader2,
  Lock,
  Moon,
  Play,
  SquareTerminal,
  Sun,
} from "lucide-react";
import { editor } from "monaco-editor/esm/vs/editor/editor.api";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import useLocalStorageState from "use-local-storage-state";

// The only languages the runner (ptyd) can execute, a curated list rather than
// the full Monaco set. `id` is the Monaco language id used for highlighting.
const LANGUAGES: { id: string; label: string }[] = [
  { id: "python", label: "Python 3" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "java", label: "Java" },
  { id: "go", label: "Go" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
];

function languageLabel(id: string): string {
  return LANGUAGES.find((l) => l.id === id)?.label ?? id;
}

function getWsUri(id: string) {
  const url = new URL(`/api/socket/${id}`, window.location.href);
  url.protocol = url.protocol == "https:" ? "wss:" : "ws:";
  return url.href;
}

function generateName() {
  return "Anonymous " + animals[Math.floor(Math.random() * animals.length)];
}

function generateHue() {
  return Math.floor(Math.random() * 360);
}

function userColor(hue: number) {
  return `hsl(${hue}, 90%, 60%)`;
}

// setTimeout overflows past ~24.8 days; rooms expire well within that.
const MAX_TIMEOUT = 2 ** 31 - 1;

export default function RoomPage({ id }: { id: string }) {
  const room = useRoom(id);
  if (room.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (room.isError) {
    return (
      <NotFound
        title="Couldn't load this room"
        description={room.error.message}
      />
    );
  }
  if (!room.data) {
    return (
      <NotFound
        title="Room not found"
        description="This link doesn't match any interview room. Ask your interviewer for a fresh link."
      />
    );
  }
  return <Pad room={room.data} />;
}

function Pad({ room }: { room: Room }) {
  const { id } = room;
  const theme = useTheme();
  const dark = theme === "dark";
  const [language, setLanguage] = useState("python");
  const [connection, setConnection] = useState<
    "connected" | "disconnected" | "desynchronized"
  >("disconnected");
  const [users, setUsers] = useState<Record<number, UserInfo>>({});
  const [name, setName] = useLocalStorageState("name", {
    defaultValue: generateName,
  });
  const [hue, setHue] = useLocalStorageState("hue", {
    defaultValue: generateHue,
  });
  const [editor, setEditor] = useState<editor.IStandaloneCodeEditor>();
  const rustpad = useRef<Rustpad>();

  // Write window. The server's Room message is authoritative; the local timer
  // only flips the UI on time if that message is late.
  const [status, setStatus] = useState<RoomStatus>({
    expiresAt: room.expiresAt,
    writable: room.writable,
    serverNow: room.serverNow ?? Date.now(),
  });
  // Server clock minus ours, so a fast or slow laptop clock doesn't lock the
  // editor early or show the wrong countdown.
  const [skew, setSkew] = useState(() =>
    room.serverNow ? room.serverNow - Date.now() : 0,
  );
  const [locallyExpired, setLocallyExpired] = useState(
    () => room.expiresAt <= Date.now() + skew,
  );
  const readOnly = !status.writable || locallyExpired;
  const serverWritable = useRef(room.writable);
  // Bumped to rebuild the client, discarding unacked edits on lock.
  const [epoch, setEpoch] = useState(0);
  const now = useNow() + skew;

  useEffect(() => {
    const ms = status.expiresAt - (Date.now() + skew);
    if (ms <= 0) {
      setLocallyExpired(true);
      return;
    }
    const timer = window.setTimeout(
      () => setLocallyExpired(true),
      Math.min(ms, MAX_TIMEOUT),
    );
    return () => window.clearTimeout(timer);
  }, [status.expiresAt, skew]);

  const termRef = useRef<TerminalHandle>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [running, setRunning] = useState(false);
  const [pendingRun, setPendingRun] = useState<{
    language: string;
    code: string;
  }>();
  const terminalOpen = showTerminal && !readOnly;

  // First-visit name prompt (remembered across sessions).
  const [nameAsked, setNameAsked] = useLocalStorageState("nameAsked", {
    defaultValue: false,
  });
  const [nameDraft, setNameDraft] = useState("");
  function submitName() {
    const n = nameDraft.trim();
    if (n) setName(n);
    setNameAsked(true);
  }

  useEffect(() => {
    if (editor?.getModel()) {
      const model = editor.getModel()!;
      model.setValue("");
      model.setEOL(0); // LF
      rustpad.current = new Rustpad({
        uri: getWsUri(id),
        editor,
        onConnected: () => setConnection("connected"),
        onDisconnected: () => setConnection("disconnected"),
        onDesynchronized: () => {
          setConnection("desynchronized");
          toast.error("Desynchronized with server", {
            description: "Please save your work and refresh the page.",
            duration: Infinity,
          });
        },
        onChangeLanguage: (language) => setLanguage(language),
        onChangeUsers: setUsers,
        onRoom: (next) => {
          setStatus(next);
          setSkew(next.serverNow - Date.now());
          if (next.writable) setLocallyExpired(false);
          if (serverWritable.current && !next.writable) {
            // Locked mid-session: rebuild so the text matches the server.
            setEpoch((e) => e + 1);
          }
          serverWritable.current = next.writable;
        },
      });
      return () => {
        rustpad.current?.dispose();
        rustpad.current = undefined;
      };
    }
  }, [id, editor, epoch, setUsers]);

  useEffect(() => {
    editor?.updateOptions({ readOnly });
  }, [editor, readOnly]);

  useEffect(() => {
    if (connection === "connected") {
      rustpad.current?.setInfo({ name, hue });
    }
  }, [connection, name, hue, epoch]);

  function handleLanguageChange(lang: string) {
    if (readOnly) return;
    setLanguage(lang);
    rustpad.current?.setLanguage(lang);
  }

  const handleRun = useCallback(() => {
    const model = editor?.getModel();
    if (!model || readOnly) return;
    if (!isRunnable(language)) {
      toast.warning("Not runnable", {
        description: `Pick a runnable language (current: ${languageLabel(language)}).`,
      });
      return;
    }
    setShowTerminal(true);
    setPendingRun({ language, code: model.getValue() });
  }, [editor, language, readOnly]);

  // Wait for the terminal's imperative handle to exist after opening it.
  useEffect(() => {
    if (terminalOpen && pendingRun && termRef.current) {
      termRef.current.run(pendingRun.language, pendingRun.code);
      setPendingRun(undefined);
    }
  }, [terminalOpen, pendingRun]);

  const handleRunRef = useRef(handleRun);
  handleRunRef.current = handleRun;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
      // Other text fields (the assistant, dialogs) own their own Enter.
      const target = e.target as HTMLElement | null;
      const typing = target?.closest(
        "input, textarea, select, [contenteditable=true]",
      );
      if (typing && !target?.closest(".monaco-editor")) return;
      e.preventDefault();
      handleRunRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function handleShare() {
    await navigator.clipboard.writeText(roomUrl(id));
    toast.success("Link copied", {
      description: "Share it with your candidate to start pairing.",
    });
  }

  const others = Object.entries(users);
  const connColor =
    connection === "connected"
      ? "bg-emerald-500"
      : connection === "desynchronized"
        ? "bg-amber-500"
        : "bg-red-500";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Toolbar */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-muted/30 px-3">
        <Brand />
        <Separator orientation="vertical" className="h-5!" />
        <span
          className="max-w-56 truncate text-sm font-medium"
          title={room.name}
        >
          {room.name}
        </span>
        <RoomStatusBadge
          expiresAt={status.expiresAt}
          writable={!readOnly}
          now={now}
        />
        <Select
          value={language}
          onValueChange={handleLanguageChange}
          disabled={readOnly}
        >
          <SelectTrigger
            size="sm"
            className="w-36 border-transparent bg-transparent shadow-none dark:bg-transparent"
            aria-label="Language"
          >
            <SelectValue>{languageLabel(language)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex-1" />

        {/* Connection status */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", connColor)} />
              <span className="hidden text-xs text-muted-foreground capitalize md:block">
                {connection === "connected" ? "Live" : connection}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent className="capitalize">{connection}</TooltipContent>
        </Tooltip>

        {/* Presence */}
        <div className="flex -space-x-2">
          <Popover>
            <PopoverTrigger
              className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="Your name and color"
            >
              <PresenceAvatar name={name} hue={hue} />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 space-y-2">
              <Label htmlFor="display-name" className="text-xs">
                Your name
              </Label>
              <Input
                id="display-name"
                value={name}
                onChange={(e) =>
                  e.target.value.length > 0 && setName(e.target.value)
                }
              />
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => setHue(generateHue())}
              >
                Change color
              </Button>
            </PopoverContent>
          </Popover>
          {others.slice(0, 4).map(([uid, info]) => (
            <Tooltip key={uid}>
              <TooltipTrigger asChild>
                <span>
                  <PresenceAvatar name={info.name} hue={info.hue} />
                </span>
              </TooltipTrigger>
              <TooltipContent>{info.name}</TooltipContent>
            </Tooltip>
          ))}
          {others.length > 4 && (
            <Avatar size="sm" className="ring-2 ring-background">
              <AvatarFallback>+{others.length - 4}</AvatarFallback>
            </Avatar>
          )}
        </div>

        <Button size="sm" variant="outline" onClick={handleShare}>
          <Link2 />
          Share
        </Button>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Toggle terminal"
              size="icon-sm"
              variant="ghost"
              disabled={readOnly}
              className={cn(terminalOpen && "text-sky-500")}
              onClick={() => setShowTerminal((v) => !v)}
            >
              <SquareTerminal />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {terminalOpen ? "Hide terminal" : "Show terminal"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Toggle theme"
              size="icon-sm"
              variant="ghost"
              onClick={toggleTheme}
            >
              {dark ? <Sun /> : <Moon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle theme</TooltipContent>
        </Tooltip>

        <Button
          size="sm"
          className="min-w-20 bg-emerald-600 text-white hover:bg-emerald-600/90"
          disabled={readOnly || !isRunnable(language)}
          onClick={handleRun}
          title={
            readOnly
              ? "This room is read-only"
              : isRunnable(language)
                ? "Run (Cmd/Ctrl + Enter)"
                : `${languageLabel(language)} is not runnable`
          }
        >
          {running ? <Loader2 className="animate-spin" /> : <Play />}
          {running ? "Running" : "Run"}
        </Button>
      </header>

      {readOnly && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
        >
          <Lock className="size-3.5" />
          This room is read-only. Interviews lock{" "}
          {formatDuration(room.expiresAt - room.createdAt)} after creation.
        </div>
      )}

      {/* Editor + terminal + assistant */}
      <div className="flex min-h-0 flex-1">
        <div className="h-full min-w-0" style={{ flex: terminalOpen ? 3 : 1 }}>
          <Editor
            theme={dark ? "vs-dark" : "vs"}
            language={language}
            beforeMount={(monaco) => {
              // This is a runner, not a compiler: code is executed server-side,
              // never type-checked here. Silence semantic diagnostics so imports
              // like `node:readline` don't show spurious "cannot find module"
              // errors (no @types/node in the browser). Keep syntax checks.
              const ts = monaco.languages.typescript;
              for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
                d.setDiagnosticsOptions({
                  noSemanticValidation: true,
                  noSyntaxValidation: false,
                });
                d.setCompilerOptions({
                  target: ts.ScriptTarget.ESNext,
                  module: ts.ModuleKind.ESNext,
                  moduleResolution: ts.ModuleResolutionKind.NodeJs,
                  allowNonTsExtensions: true,
                });
              }
            }}
            options={{
              automaticLayout: true,
              fontSize: 14,
              minimap: { enabled: false },
              padding: { top: 12 },
              scrollBeyondLastLine: false,
              readOnly,
              readOnlyMessage: { value: "This room is read-only." },
            }}
            onMount={(ed) => setEditor(ed)}
          />
        </div>
        {terminalOpen && (
          <div className="h-full min-w-0 border-l" style={{ flex: 2 }}>
            <Terminal
              ref={termRef}
              padId={id}
              darkMode={dark}
              language={language}
              onClose={() => setShowTerminal(false)}
              onRunningChange={setRunning}
            />
          </div>
        )}
        {room.assistant !== false && (
          <AssistantPanel
            key={id}
            padId={id}
            language={language}
            editor={editor}
            readOnly={readOnly}
          />
        )}
      </div>

      {/* First-visit name prompt */}
      <Dialog
        open={!nameAsked}
        onOpenChange={(open) => !open && setNameAsked(true)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Welcome to RebarPad</DialogTitle>
            <DialogDescription>
              What should we call you? Others in the pad will see this name.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder={name}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitName()}
          />
          <DialogFooter>
            <Button onClick={submitName}>Join</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PresenceAvatar({ name, hue }: { name: string; hue: number }) {
  return (
    <Avatar size="sm" className="ring-2 ring-background">
      <AvatarFallback
        className="font-medium text-white"
        style={{ background: userColor(hue) }}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
