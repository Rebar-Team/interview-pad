import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Info, Lock, Sparkles, TriangleAlert } from "lucide-react";
import type { editor } from "monaco-editor/esm/vs/editor/editor.api";
import { useEffect, useRef, useState } from "react";

import { AssistantSocket, type ChatMessage, applyEvent } from "./client";
import { type Chunk, collapseContext, parsePatch } from "./proposal";

type Props = {
  padId: string;
  language: string;
  editor?: editor.IStandaloneCodeEditor;
  readOnly: boolean;
  /** This participant's display name, shown on their questions. */
  name: string;
};

/** The room's Interview Assistant chat, shared live with everyone in the pad. */
export default function AssistantPanel({
  padId,
  language,
  editor: ed,
  readOnly,
  name,
}: Props) {
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
      setConnected,
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
      aria-label="Rebar Interview Assistant"
      className="flex h-full w-[360px] max-w-[45vw] min-w-[300px] shrink-0 flex-col border-l bg-muted/30"
    >
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
              Describe what you want the code to do, and the assistant writes it
              for you to review and apply. Everyone in this room sees the chat.
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
        {error && (
          <p role="alert" className="mb-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {readOnly ? (
          <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 text-xs text-muted-foreground">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            The assistant is off because this room is read-only.
          </div>
        ) : (
          <>
            <Textarea
              aria-label="Ask Rebar Interview Assistant"
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
