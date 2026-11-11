import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Info, Lock, Sparkles, TriangleAlert } from "lucide-react";
import type { editor } from "monaco-editor/esm/vs/editor/editor.api";
import { useEffect, useRef, useState } from "react";
import useLocalStorageState from "use-local-storage-state";

import {
  AssistantSocket,
  type ChatMessage,
  type Draft,
  applyEvent,
} from "./client";
import { type Chunk, collapseContext, parsePatch } from "./proposal";

type Props = {
  padId: string;
  language: string;
  editor?: editor.IStandaloneCodeEditor;
  readOnly: boolean;
  enabled: boolean;
  /** This participant's display name, shown on their questions. */
  name: string;
};

/** The room's Interview Assistant chat, shared live with everyone in the pad. */
export default function AssistantPanel({
  padId,
  language,
  editor: ed,
  readOnly: roomReadOnly,
  enabled,
  name,
}: Props) {
  const readOnly = roomReadOnly || !enabled;
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [preferredWidth, setPreferredWidth] = useLocalStorageState<number>(
    "assistant-width",
    { defaultValue: 360 },
  );
  const [maxWidth, setMaxWidth] = useState(600);
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number }>();
  const minWidth = Math.min(300, maxWidth);
  const width = Math.max(
    minWidth,
    Math.min(maxWidth, Number.isFinite(preferredWidth) ? preferredWidth : 360),
  );
  const resize = (next: number) =>
    setPreferredWidth(Math.max(minWidth, Math.min(maxWidth, next)));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  /** A question of ours is on its way, before the server reports it busy. */
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  /** The edit this browser asked to apply or undo, until the server answers. */
  const [pending, setPending] = useState<number | null>(null);
  const socket = useRef<AssistantSocket>();
  /** A question sent but not yet posted, restored if it never lands. */
  const sent = useRef("");
  /** The name that question was sent under, in case the asker renames. */
  const sentBy = useRef("");
  // As the server records it, to recognize this person's questions.
  const asker = useRef("");
  asker.current = [...name.trim()].slice(0, 64).join("") || "Someone";
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const chat = new AssistantSocket(
      padId,
      (event) => {
        if (event.type === "snapshot" || event.type === "drafts")
          setDrafts(event.drafts ?? []);
        if (event.type === "error") {
          setError(event.error);
          if (event.request === "apply" || event.request === "undo")
            setPending(null);
          // Only a refused question goes back in the box; an apply or clear
          // failure says nothing about the question in flight.
          if (event.request !== "ask") return;
          setSending(false);
          const refused = sent.current;
          sent.current = "";
          if (refused) setDraft((current) => current || refused);
          return;
        }
        if (
          event.type === "message" &&
          event.message.role === "user" &&
          event.message.author === sentBy.current &&
          event.message.content === sent.current
        ) {
          sent.current = "";
          setSending(false);
        }
        if (event.type === "snapshot" || event.type === "busy")
          setBusy(event.busy);
        if (event.type === "message")
          setPending((id) => (id === event.message.id ? null : id));
        if (event.type === "snapshot") {
          // A reconnect drops any request still waiting for an answer.
          setPending(null);
          setSending(false);
          const pending = sent.current;
          sent.current = "";
          const mine = event.messages.findLast(
            (m) => m.role === "user" && m.author === sentBy.current,
          );
          // Lost with the old connection unless it was posted or is being taken up.
          if (
            pending &&
            mine?.content !== pending &&
            event.busy !== sentBy.current
          ) {
            setDraft((current) => current || pending);
            setError(
              "Your question didn't reach the assistant before the connection dropped. Send it again.",
            );
          }
        }
        setMessages((current) => applyEvent(current, event));
      },
      (connected) => {
        setConnected(connected);
        if (!connected) setDrafts([]);
      },
    );
    socket.current = chat;
    return () => {
      chat.dispose();
      socket.current = undefined;
    };
  }, [padId]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages, busy]);

  useEffect(() => {
    if (connected) socket.current?.sendDraft(readOnly ? "" : draft, name);
  }, [draft, name, connected, readOnly]);

  useEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(([entry]) => {
      setMaxWidth(Math.max(240, Math.floor(entry.contentRect.width * 0.6)));
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  function send() {
    const question = draft.trim(),
      code = ed?.getValue();
    if (!question || code === undefined || busy || sending || readOnly) return;
    const position = ed?.getPosition();
    const selection = ed?.getSelection();
    const selected =
      selection && !selection.isEmpty()
        ? (ed?.getModel()?.getValueInRange(selection) ?? "")
        : "";
    const ok = socket.current?.send({
      type: "ask",
      message: question,
      code,
      language,
      // Where the asker is, so "here" and "this function" resolve.
      cursor: position
        ? { line: position.lineNumber, selection: selected.slice(0, 4000) }
        : undefined,
      author: name,
    });
    if (!ok) {
      setError("Not connected to the assistant yet. Reconnecting...");
      return;
    }
    socket.current?.sendDraft("", name);
    sent.current = question;
    sentBy.current = asker.current;
    setSending(true);
    setError("");
    setDraft("");
  }

  function clear() {
    setError("");
    if (!socket.current?.send({ type: "clear" }))
      setError("Not connected to the assistant yet. Reconnecting...");
  }

  /** Have the server apply (or undo) an edit to the shared code. */
  function change(message: ChatMessage, undo: boolean) {
    setError("");
    const ok = socket.current?.send(
      undo
        ? { type: "undo", id: message.id }
        : { type: "apply", id: message.id, author: name },
    );
    if (!ok) {
      setError("Not connected to the assistant yet. Reconnecting...");
      return;
    }
    setPending(message.id);
  }

  return (
    <aside
      ref={panel}
      aria-label="Rebar Interview Assistant"
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-l bg-muted/30"
    >
      <div
        role="separator"
        aria-label="Resize assistant sidebar"
        aria-orientation="vertical"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline-none"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current)
            resize(drag.current.width + drag.current.x - event.clientX);
        }}
        onPointerUp={(event) => {
          drag.current = undefined;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = undefined;
        }}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          resize(
            event.key === "Home"
              ? minWidth
              : event.key === "End"
                ? maxWidth
                : width + (event.key === "ArrowLeft" ? 20 : -20),
          );
        }}
      />
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-3.5 text-muted-foreground" />
          Interview Assistant
          {!connected && (
            <span className="text-xs font-normal text-muted-foreground">
              (reconnecting)
            </span>
          )}
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={clear}
          disabled={readOnly || !!busy || messages.length === 0}
        >
          Clear chat
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          {messages.length === 0 && !busy && (
            <p className="text-sm text-muted-foreground">
              {readOnly
                ? "No chat history for this room."
                : "Describe what you want the code to do, and the assistant writes it for you to review and apply. Everyone in this room sees the chat."}
            </p>
          )}
          {messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="ml-6 space-y-1">
                <p className="text-right text-xs text-muted-foreground">
                  {message.author}
                </p>
                <div className="rounded-lg bg-secondary px-3 py-2 text-sm wrap-anywhere whitespace-pre-wrap">
                  {message.content}
                </div>
              </div>
            ) : (
              <Reply
                key={message.id}
                message={message}
                disabled={readOnly || pending !== null}
                onApply={() => change(message, false)}
                onUndo={() => change(message, true)}
              />
            ),
          )}
          {busy && (
            <p className="animate-pulse text-sm text-muted-foreground">
              Thinking about {busy === asker.current ? "your" : `${busy}'s`}{" "}
              question...
            </p>
          )}
          <div ref={end} />
        </div>
      </ScrollArea>
      <div className="shrink-0 border-t p-3">
        {drafts.length > 0 && (
          <div
            aria-label="Other participants' drafts"
            className="mb-3 max-h-40 space-y-3 overflow-y-auto text-sm text-muted-foreground"
          >
            {drafts.map((draft) => (
              <div key={draft.id}>
                <p className="text-xs font-medium">{draft.author} is typing…</p>
                <p className="whitespace-pre-wrap wrap-anywhere">
                  {draft.text}
                </p>
              </div>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="mb-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {readOnly ? (
          <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            {enabled
              ? "The assistant is off because this room is read-only."
              : "The assistant is disabled for this room. Chat history is read-only."}
          </div>
        ) : (
          <>
            <Textarea
              aria-label="Ask Rebar Interview Assistant"
              aria-describedby="assistant-draft-notice"
              placeholder="Ask the Interview Assistant"
              value={draft}
              rows={3}
              className="max-h-40 resize-none text-sm"
              maxLength={2000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <p
              id="assistant-draft-notice"
              className="mt-2 text-xs text-muted-foreground"
            >
              Your draft is visible to everyone in this room.
            </p>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Enter to send
              </span>
              <Button
                size="sm"
                onClick={send}
                disabled={
                  !draft.trim() || !!busy || sending || !ed || !connected
                }
              >
                Send
              </Button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function Reply({
  message,
  disabled,
  onApply,
  onUndo,
}: {
  message: ChatMessage;
  disabled: boolean;
  onApply: () => void;
  onUndo: () => void;
}) {
  if (message.kind === "error")
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="wrap-anywhere whitespace-pre-wrap">
          {message.content}
        </span>
      </div>
    );
  return (
    <div className="space-y-3">
      <p className="text-sm wrap-anywhere whitespace-pre-wrap">
        {message.content}
      </p>
      {message.notice && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" />
          {message.notice}
        </p>
      )}
      {message.patch && (
        <Proposal
          patch={message.patch}
          appliedBy={message.appliedBy}
          disabled={disabled}
          onApply={onApply}
          onUndo={onUndo}
        />
      )}
    </div>
  );
}

/** A proposed edit as a line diff. The server applies it (and undoes it) for everyone. */
function Proposal({
  patch,
  appliedBy,
  disabled,
  onApply,
  onUndo,
}: {
  patch: string;
  appliedBy: string | null;
  disabled: boolean;
  onApply: () => void;
  onUndo: () => void;
}) {
  let chunks: Chunk[] = [];
  try {
    chunks = parsePatch(patch);
  } catch {
    // The server built and checked it; an unparsable patch just renders empty.
  }
  const lines = chunks.flatMap((c) => c.lines);
  const added = lines.filter((l) => l.op === "+").length;
  const removed = lines.filter((l) => l.op === "-").length;
  return (
    <div className="overflow-hidden rounded-lg border bg-background text-xs">
      <pre className="max-h-72 overflow-auto py-2 font-mono wrap-anywhere whitespace-pre-wrap">
        {chunks.map((chunk, c) => (
          <div key={c} className={cn(c > 0 && "mt-2 border-t pt-2")}>
            {collapseContext(chunk.lines).map((line, k) =>
              line.op === "skip" ? (
                <div key={k} className="px-3 text-muted-foreground/70">
                  {`  ⋯ ${line.count} unchanged line${line.count === 1 ? "" : "s"}`}
                </div>
              ) : (
                <div
                  key={k}
                  className={
                    line.op === "-"
                      ? "bg-red-500/10 px-3 text-red-700 dark:text-red-300"
                      : line.op === "+"
                        ? "bg-emerald-500/10 px-3 text-emerald-700 dark:text-emerald-300"
                        : "px-3 text-muted-foreground"
                  }
                >
                  {line.op === " " ? "  " : `${line.op} `}
                  {line.text || " "}
                </div>
              ),
            )}
          </div>
        ))}
      </pre>
      <div className="flex items-center justify-between gap-2 border-t p-2 pl-3">
        <span className="text-muted-foreground">
          <span className="text-emerald-700 dark:text-emerald-300">
            +{added}
          </span>{" "}
          <span className="text-red-700 dark:text-red-300">−{removed}</span>
        </span>
        {appliedBy ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            Applied by {appliedBy}
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={onUndo}
            >
              Undo
            </Button>
          </span>
        ) : (
          <Button size="xs" disabled={disabled} onClick={onApply}>
            Apply edit
          </Button>
        )}
      </div>
    </div>
  );
}
