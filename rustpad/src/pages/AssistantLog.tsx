import { Brand } from "@/components/Brand";
import { Link } from "@/components/Link";
import { NotFound } from "@/components/NotFound";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  type AssistantLogEntry,
  api,
  loginUrl,
  useRoom,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

/** Every Interview Assistant interaction in a room, in full, for interviewers. */
export default function AssistantLog({ id }: { id: string }) {
  const room = useRoom(id);
  const log = useQuery({
    queryKey: ["assistantLog", id],
    queryFn: () => api.assistantLog(id),
    refetchInterval: 15_000,
  });
  if (log.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (log.error instanceof ApiError && log.error.status === 401) {
    window.location.assign(loginUrl());
    return null;
  }
  if (log.isError) {
    return (
      <NotFound
        title="Couldn't load the assistant log"
        description={log.error.message}
      />
    );
  }
  return (
    <div className="min-h-full">
      <header className="flex h-14 items-center gap-3 border-b px-6">
        <Brand />
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/r/${id}`}>
            <ArrowLeft />
            Back to room
          </Link>
        </Button>
      </header>
      <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Assistant log{room.data ? `: ${room.data.name}` : ""}
          </h1>
          <p className="text-sm text-muted-foreground">
            Every question, the code it was asked about, each model call and its
            raw output, oldest first. Includes chat that was cleared.
          </p>
        </div>
        {log.data.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No assistant interactions in this room yet.
          </p>
        )}
        {log.data.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
      </main>
    </div>
  );
}

function Entry({ entry }: { entry: AssistantLogEntry }) {
  const outcome = entry.error ? "error" : entry.reply.kind;
  const tokens = entry.attempts.reduce(
    (sum, a) =>
      sum + (a.usage?.input_tokens ?? 0) + (a.usage?.output_tokens ?? 0),
    0,
  );
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{new Date(entry.createdAt).toLocaleString()}</span>
        <span className="font-medium text-foreground">{entry.author}</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-medium",
            outcome === "error"
              ? "bg-amber-500/15 text-amber-800 dark:text-amber-200"
              : "bg-muted text-foreground",
          )}
        >
          {outcome}
        </span>
        <span>{(entry.tookMs / 1000).toFixed(1)}s</span>
        <span>
          {entry.attempts.length} call{entry.attempts.length === 1 ? "" : "s"}
        </span>
        {tokens > 0 && <span>{tokens.toLocaleString()} tokens</span>}
        <span>{entry.model}</span>
        {entry.askedAlready && <span>follow-up to a question</span>}
      </div>
      <Field label="Question">
        <p className="whitespace-pre-wrap">{entry.question}</p>
      </Field>
      <Field label="Reply">
        {entry.error ? (
          <p className="whitespace-pre-wrap text-amber-800 dark:text-amber-200">
            {entry.error}
          </p>
        ) : (
          <div className="space-y-2">
            <p className="whitespace-pre-wrap">{entry.reply.content}</p>
            {entry.reply.notice && (
              <p className="text-xs text-muted-foreground">
                {entry.reply.notice}
              </p>
            )}
            {entry.reply.patch && <Code text={entry.reply.patch} />}
          </div>
        )}
      </Field>
      <Fold
        label={`Code when asked (${entry.language}${entry.cursor ? `, cursor on line ${entry.cursor.line}` : ""})`}
      >
        <Code text={entry.code || "(empty)"} />
      </Fold>
      {entry.attempts.map((attempt, k) => (
        <Fold
          key={k}
          label={`Model call ${k + 1}: ${(attempt.took_ms / 1000).toFixed(1)}s${attempt.problem ? `, not used: ${attempt.problem}` : ""}`}
        >
          <Code text={rawOutput(attempt.output)} />
        </Fold>
      ))}
      <Fold label={`Memory sent (${entry.history.length} messages)`}>
        <div className="space-y-2">
          {entry.history.map((m, k) => (
            <div key={k}>
              <p className="text-xs font-medium text-muted-foreground">
                {m.role}
              </p>
              <p className="text-sm whitespace-pre-wrap">{m.content}</p>
            </div>
          ))}
        </div>
      </Fold>
    </section>
  );
}

/** The model's raw JSON output, pretty-printed when it parses. */
function rawOutput(output: string): string {
  if (!output) return "(no output)";
  try {
    const parsed = JSON.parse(output);
    const { code, ...rest } = parsed;
    return `${JSON.stringify(rest, null, 2)}\n\ncode:\n${code ?? "null"}`;
  } catch {
    return output;
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function Fold({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground select-none">
        {label}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

function Code({ text }: { text: string }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre">
      {text}
    </pre>
  );
}
