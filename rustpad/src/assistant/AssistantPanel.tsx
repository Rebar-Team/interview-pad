import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Lock, Sparkles } from "lucide-react";
import type { editor } from "monaco-editor/esm/vs/editor/editor.api";
import { useEffect, useRef, useState } from "react";

import { Answer, AssistantClient, AssistantError } from "./client";
import { replacement } from "./proposal";

type Turn = {
  question: string;
  answer?: Answer;
  snapshot: string;
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
    setTurns((items) => [...items.slice(-5), { question, snapshot }]);
    try {
      const answer = await client.request("chat", {
        padId,
        language,
        code: snapshot,
        message: question,
      });
      if (active.current)
        setTurns((items) =>
          items.map((t, i) => (i === items.length - 1 ? { ...t, answer } : t)),
        );
    } catch (e) {
      // 409: a newer request from this browser (another tab) replaced this
      // one. Drop the unanswered question rather than leave it hanging.
      if (e instanceof AssistantError && e.status === 409) {
        if (active.current)
          setTurns((items) =>
            items.filter((t, i) => i !== items.length - 1 || t.answer),
          );
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

  function apply(turn: Turn, index: number) {
    try {
      const model = ed?.getModel(),
        edit = turn.answer?.edit;
      if (!ed || !model || !edit) return;
      const patch = replacement(model.getValue(), turn.snapshot, edit);
      const a = model.getPositionAt(patch.start),
        b = model.getPositionAt(patch.end);
      ed.pushUndoStop();
      ed.executeEdits("luna", [
        {
          range: {
            startLineNumber: a.lineNumber,
            startColumn: a.column,
            endLineNumber: b.lineNumber,
            endColumn: b.column,
          },
          text: patch.text,
        },
      ]);
      ed.pushUndoStop();
      setTurns((items) =>
        items.map((t, i) => (i === index ? { ...t, applied: true } : t)),
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
          {turns.map((turn, i) => (
            <div key={i} className="space-y-3">
              <div className="ml-6 rounded-lg bg-secondary px-3 py-2 text-sm wrap-anywhere whitespace-pre-wrap">
                {turn.question}
              </div>
              {turn.answer && (
                <div className="space-y-3">
                  <p className="text-sm wrap-anywhere whitespace-pre-wrap">
                    {turn.answer.message}
                  </p>
                  {turn.answer.edit && (
                    <div className="overflow-hidden rounded-lg border bg-background text-xs">
                      <pre className="max-h-48 overflow-auto bg-red-500/10 px-3 py-2 font-mono wrap-anywhere whitespace-pre-wrap text-red-700 dark:text-red-300">
                        {turn.answer.edit.before || "(empty)"}
                      </pre>
                      <pre className="max-h-48 overflow-auto border-t bg-emerald-500/10 px-3 py-2 font-mono wrap-anywhere whitespace-pre-wrap text-emerald-700 dark:text-emerald-300">
                        {turn.answer.edit.after || "(delete)"}
                      </pre>
                      <div className="flex justify-end border-t p-2">
                        <Button
                          size="xs"
                          onClick={() => apply(turn, i)}
                          disabled={turn.applied || !ed || readOnly}
                        >
                          {turn.applied ? "Applied" : "Apply edit"}
                        </Button>
                      </div>
                    </div>
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
