import { Box, Flex, HStack, Icon, IconButton, Text } from "@chakra-ui/react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { VscChevronDown, VscTerminal } from "react-icons/vsc";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

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
  onClose: () => void;
};

function ptyUri(id: string) {
  const url = new URL(`pty/${id}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { padId, darkMode, onClose },
  ref,
) {
  const boxRef = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm>();
  const fit = useRef<FitAddon>();
  const ws = useRef<WebSocket>();
  const pending = useRef<object | null>(null); // a run queued until the socket opens

  // Send helper — opens/reopens the socket if needed and flushes a queued run.
  function connect() {
    if (ws.current && (ws.current.readyState === WebSocket.OPEN || ws.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const sock = new WebSocket(ptyUri(padId));
    ws.current = sock;
    sock.onopen = () => {
      if (pending.current) { sock.send(JSON.stringify(pending.current)); pending.current = null; }
    };
    sock.onmessage = (ev) => {
      let m: { t: string; d?: string; code?: number };
      try { m = JSON.parse(ev.data); } catch { return; }
      const t = term.current;
      if (!t) return;
      if (m.t === "out" || m.t === "info") t.write(m.d ?? "");
      else if (m.t === "exit") t.write(`\r\n\x1b[90m[process exited with code ${m.code}]\x1b[0m\r\n`);
    };
    sock.onclose = () => { if (ws.current === sock) ws.current = undefined; };
  }

  function send(obj: object) {
    const sock = ws.current;
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(obj));
    else { pending.current = obj; connect(); }
  }

  useImperativeHandle(ref, () => ({
    run: (lang: string, code: string) => {
      const t = term.current;
      const cols = t?.cols ?? 80;
      const rows = t?.rows ?? 24;
      send({ t: "run", lang, code, cols, rows });
      t?.focus();
    },
  }));

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
      t.dispose();
      term.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padId]);

  // React to theme changes without recreating the terminal.
  useEffect(() => {
    if (term.current) {
      term.current.options.theme = darkMode
        ? { background: "#1e1e1e", foreground: "#cbcaca" }
        : { background: "#ffffff", foreground: "#1e1e1e", cursor: "#333333" };
    }
  }, [darkMode]);

  const headerBg = darkMode ? "#252526" : "#f0f0f0";
  const border = darkMode ? "#333333" : "#e2e2e2";

  return (
    <Flex direction="column" h="100%" borderTop="1px solid" borderColor={border} bgColor={darkMode ? "#1e1e1e" : "#ffffff"}>
      <HStack h={7} px={2} flexShrink={0} bgColor={headerBg} color={darkMode ? "#cccccc" : "#383838"} justify="space-between">
        <HStack spacing={1.5}>
          <Icon as={VscTerminal} fontSize="sm" />
          <Text fontSize="xs" fontWeight="medium">Terminal</Text>
        </HStack>
        <IconButton aria-label="Collapse terminal" icon={<VscChevronDown />} size="xs" variant="ghost" onClick={onClose} />
      </HStack>
      <Box ref={boxRef} flex={1} minH={0} px={1} py={1} />
    </Flex>
  );
});

export default Terminal;
