import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Lock, Sparkles, TriangleAlert } from "lucide-react";
import type { editor } from "monaco-editor/esm/vs/editor/editor.api";
import { useEffect, useRef, useState } from "react";

import { Answer, AssistantClient, AssistantError } from "./client";
import {
  type Chunk,
  applyPatch,
  minimalEdit,
  parsePatch,
  removedLines,
} from "./proposal";

type Turn = {
  /** Stable across the list shifting, so per-proposal state never moves. */
  id: number;
  question: string;
  answer?: Answer;
  applied?: boolean;
};
type Props = {
  padId: string;
  language: string;
  editor?: editor.IStandaloneCodeEditor;
  readOnly: boolean;
};

export default function AssistantPanel({
  padId,
  language,
  editor: ed,
  readOnly,
}: Props) {
  const [client] = useState(() => new AssistantClient());
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const nextId = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      client.cancel();
    };
  }, [client]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, busy]);

  async function send() {
    const question = draft.trim(),
      snapshot = ed?.getValue();
    if (!question || snapshot === undefined || busy || readOnly) return;
    setBusy(true);
    setError("");
    setDraft("");
    const id = nextId.current++;
    setTurns((items) => [...items.slice(-5), { id, question }]);
    try {
      const position = ed?.getPosition();
      const selection = ed?.getSelection();
      const selected =
        selection && !selection.isEmpty()
          ? (ed?.getModel()?.getValueInRange(selection) ?? "")
          : "";
      const answer = await client.request("chat", {
        padId,
        language,
        code: snapshot,
        message: question,
        // Where the user is, so "here" and "this function" resolve.
        cursor: position
          ? { line: position.lineNumber, selection: selected.slice(0, 4000) }
          : undefined,
      });
      if (active.current)
        setTurns((items) =>
          items.map((t) => (t.id === id ? { ...t, answer } : t)),
        );
    } catch (e) {
      // 409: a newer request from this browser (another tab) replaced this
      // one. Drop the unanswered question rather than leave it hanging.
      if (e instanceof AssistantError && e.status === 409) {
        if (active.current)
          setTurns((items) => items.filter((t) => t.id !== id || t.answer));
        return;
      }
      if (active.current)
        setError(
          e instanceof Error ? e.message : "Interview Assistant unavailable.",
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError("");
    try {
      await client.request("reset", { padId });
      if (active.current) setTurns([]);
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }

  function apply(turn: Turn) {
    try {
      const model = ed?.getModel(),
        patch = turn.answer?.patch;
      if (!ed || !model || !patch) return;
      // Re-locate against the live code (like Codex), so edits elsewhere since
      // the question don't invalidate the proposal.
      const current = model.getValue();
      const change = minimalEdit(current, applyPatch(current, patch));
      const a = model.getPositionAt(change.start),
        b = model.getPositionAt(change.end);
      ed.pushUndoStop();
      ed.executeEdits("luna", [
        {
          range: {
            startLineNumber: a.lineNumber,
            startColumn: a.column,
            endLineNumber: b.lineNumber,
            endColumn: b.column,
          },
          text: change.text,
        },
      ]);
      ed.pushUndoStop();
      setTurns((items) =>
        items.map((t) => (t.id === turn.id ? { ...t, applied: true } : t)),
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
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
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={clear}
          disabled={busy || turns.length === 0}
        >
          Clear chat
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          {turns.length === 0 && !busy && (
            <p className="text-sm text-muted-foreground">
              Describe the logic you want and the assistant turns it into code
              you can review and apply.
            </p>
          )}
          {turns.map((turn) => (
            <div key={turn.id} className="space-y-3">
              <div className="ml-6 rounded-lg bg-secondary px-3 py-2 text-sm wrap-anywhere whitespace-pre-wrap">
                {turn.question}
              </div>
              {turn.answer && (
                <div className="space-y-3">
                  <p className="text-sm wrap-anywhere whitespace-pre-wrap">
                    {turn.answer.message}
                  </p>
                  {turn.answer.patch && (
                    <Proposal
                      patch={turn.answer.patch}
                      applied={!!turn.applied}
                      disabled={!ed || readOnly}
                      onApply={() => apply(turn)}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <p className="animate-pulse text-sm text-muted-foreground">
              Thinking...
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
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
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
                disabled={!draft.trim() || busy || !ed}
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

/**
 * A proposal as a line diff. Deleting existing lines is never what an
 * insertion should do, so it is called out and Apply needs a second click.
 */
function Proposal({
  patch,
  applied,
  disabled,
  onApply,
}: {
  patch: string;
  applied: boolean;
  disabled: boolean;
  onApply: () => void;
}) {
  const [armed, setArmed] = useState(false);
  let chunks: Chunk[] = [];
  try {
    chunks = parsePatch(patch);
  } catch {
    // The server validated it; an unparsable patch just renders empty.
  }
  const removed = removedLines(chunks);
  return (
    <div className="overflow-hidden rounded-lg border bg-background text-xs">
      <pre className="max-h-64 overflow-auto py-2 font-mono wrap-anywhere whitespace-pre-wrap">
        {chunks.map((chunk, c) => (
          <div key={c}>
            {chunk.context !== null && (
              <div className="px-3 text-sky-700 dark:text-sky-300">
                @@ {chunk.context}
              </div>
            )}
            {chunk.lines.map((line, k) => (
              <div
                key={k}
                className={
                  line.op === "-"
                    ? "bg-red-500/10 px-3 text-red-700 line-through decoration-red-500/40 dark:text-red-300"
                    : line.op === "+"
                      ? "bg-emerald-500/10 px-3 text-emerald-700 dark:text-emerald-300"
                      : "px-3 text-muted-foreground"
                }
              >
                {line.op === " " ? "  " : `${line.op} `}
                {line.text || " "}
              </div>
            ))}
          </div>
        ))}
      </pre>
      {removed > 0 && !applied && (
        <p className="flex items-start gap-1.5 border-t bg-red-500/10 px-3 py-2 text-red-700 dark:text-red-300">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          Changes or removes {removed} existing line
          {removed === 1 ? "" : "s"} of code.
        </p>
      )}
      <div className="flex justify-end gap-2 border-t p-2">
        {armed && !applied && (
          <Button size="xs" variant="ghost" onClick={() => setArmed(false)}>
            Cancel
          </Button>
        )}
        <Button
          size="xs"
          variant={removed > 0 && !applied ? "destructive" : "default"}
          disabled={applied || disabled}
          onClick={() => {
            if (removed > 0 && !armed) {
              setArmed(true);
              return;
            }
            onApply();
          }}
        >
          {applied
            ? "Applied"
            : removed > 0
              ? armed
                ? `Yes, remove ${removed} line${removed === 1 ? "" : "s"}`
                : "Apply edit"
              : "Apply edit"}
        </Button>
      </div>
    </div>
  );
}
