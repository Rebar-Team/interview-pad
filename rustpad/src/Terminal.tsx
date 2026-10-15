import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, Eraser, Square, SquareTerminal } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { Button } from "./components/ui/button";

// Monaco language ids that ptyd can execute (must match ptyd's LANGS).
const RUNNABLE = new Set([
  "python",
  "javascript",
  "typescript",
  "java",
  "go",
  "c",
  "cpp",
]);

export function isRunnable(language: string): boolean {
  return RUNNABLE.has(language);
}

export type TerminalHandle = { run: (lang: string, code: string) => void };

type TerminalProps = {
  padId: string;
  darkMode: boolean;
  language: string;
  onClose: () => void;
  onRunningChange?: (running: boolean) => void;
};

function ptyUri(id: string) {
  const url = new URL(`/pty/${id}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { padId, darkMode, language, onClose, onRunningChange },
  ref,
) {
  const boxRef = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm>();
  const fit = useRef<FitAddon>();
  const ws = useRef<WebSocket>();
  // Messages queued until the socket opens. A queue, not one slot: the first
  // resize fires while connecting and must not overwrite a queued run.
  const pending = useRef<object[]>([]);
  const runningCb = useRef(onRunningChange);
  runningCb.current = onRunningChange;
  const langRef = useRef(language);
  langRef.current = language;

  // Send helper — opens/reopens the socket if needed and flushes a queued run.
  function connect() {
    if (
      ws.current &&
      (ws.current.readyState === WebSocket.OPEN ||
        ws.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const sock = new WebSocket(ptyUri(padId));
    ws.current = sock;
    sock.onopen = () => {
      // Start (or attach to) the sandboxed shell for the current language so the
      // terminal is immediately typeable.
      sock.send(
        JSON.stringify({
          t: "shell",
          lang: langRef.current,
          cols: term.current?.cols,
          rows: term.current?.rows,
        }),
      );
      for (const msg of pending.current) sock.send(JSON.stringify(msg));
      pending.current = [];
    };
    sock.onmessage = (ev) => {
      let m: { t: string; d?: string; code?: number };
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const t = term.current;
      if (!t) return;
      if (m.t === "out" || m.t === "info") t.write(m.d ?? "");
      else if (m.t === "exit") {
        // ptyd sends a bare exit whenever the shell is back at its prompt.
        if (m.code !== undefined)
          t.write(
            `\r\n\x1b[90m[process exited with code ${m.code}]\x1b[0m\r\n`,
          );
        runningCb.current?.(false);
      }
    };
    sock.onclose = () => {
      if (ws.current === sock) ws.current = undefined;
      runningCb.current?.(false);
    };
  }

  function send(obj: object) {
    const sock = ws.current;
    if (sock && sock.readyState === WebSocket.OPEN)
      sock.send(JSON.stringify(obj));
    else {
      pending.current.push(obj);
      connect();
    }
  }

  useImperativeHandle(ref, () => ({
    run: (lang: string, code: string) => {
      const t = term.current;
      const cols = t?.cols ?? 80;
      const rows = t?.rows ?? 24;
      send({ t: "run", lang, code, cols, rows });
      runningCb.current?.(true);
      t?.focus();
    },
  }));

  function clearTerminal() {
    term.current?.clear();
    send({ t: "clear" });
  }

  function stopRun() {
    send({ t: "stop" });
    runningCb.current?.(false);
  }

  // Create the xterm instance once.
  useEffect(() => {
    if (!boxRef.current) return;
    const t = new XTerm({
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      cursorBlink: true,
      convertEol: false,
      theme: darkMode
        ? { background: "#1e1e1e", foreground: "#cbcaca" }
        : { background: "#ffffff", foreground: "#1e1e1e", cursor: "#333333" },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    // Swallow ptyd's invisible run-complete marker (OSC 777) so it never renders.
    t.parser.registerOscHandler(777, () => true);
    t.open(boxRef.current);
    f.fit();
    term.current = t;
    fit.current = f;

    // keystrokes -> server
    const dataSub = t.onData((d) => send({ t: "in", d }));

    connect();

    const ro = new ResizeObserver(() => {
      try {
        f.fit();
        send({ t: "resize", cols: t.cols, rows: t.rows });
      } catch {}
    });
    ro.observe(boxRef.current);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      ws.current?.close();
      runningCb.current?.(false);
      t.dispose();
      term.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padId]);

  // Swap the sandboxed shell when the language changes.
  useEffect(() => {
    const sock = ws.current;
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ t: "shell", lang: language }));
    }
  }, [language]);

  // React to theme changes without recreating the terminal.
  useEffect(() => {
    if (term.current) {
      term.current.options.theme = darkMode
        ? { background: "#1e1e1e", foreground: "#cbcaca" }
        : { background: "#ffffff", foreground: "#1e1e1e", cursor: "#333333" };
    }
  }, [darkMode]);

  const background = darkMode ? "#1e1e1e" : "#ffffff";

  return (
    <div className="flex h-full flex-col" style={{ background }}>
      <div className="flex h-8 shrink-0 items-center justify-between border-b bg-muted/40 px-2 text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <SquareTerminal className="size-3.5" />
          <span className="text-xs font-medium">Terminal</span>
        </div>
        <div className="flex items-center">
          <Button
            aria-label="Stop"
            title="Stop the running program"
            size="icon-xs"
            variant="ghost"
            onClick={stopRun}
          >
            <Square />
          </Button>
          <Button
            aria-label="Clear"
            title="Clear terminal"
            size="icon-xs"
            variant="ghost"
            onClick={clearTerminal}
          >
            <Eraser />
          </Button>
          <Button
            aria-label="Collapse terminal"
            title="Hide terminal"
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
          >
            <ChevronDown />
          </Button>
        </div>
      </div>
      <div ref={boxRef} className="min-h-0 flex-1 p-1" />
    </div>
  );
});

export default Terminal;
