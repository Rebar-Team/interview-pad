// ptyd — interactive sandboxed shell per pad for InterviewPad.
//
// Each pad gets ONE long-lived, locked-down container running an interactive
// shell attached to a PTY, streamed over WebSocket. The terminal is therefore
// always typeable (a real sandboxed shell), and "Run" just injects the compile
// / run command for the selected language into that shell. Because the
// container stays warm, repeat runs skip container startup, and language build
// caches (e.g. Go's) persist in the pad's volume.
//
// Every socket on the same pad shares the shell: all see it, any can type.
//
// Protocol (JSON):
//   client -> server: {t:"shell", lang} | {t:"run", lang, code} | {t:"in", d}
//                      | {t:"resize", cols, rows} | {t:"clear"} | {t:"stop"}
//   server -> client: {t:"out", d} | {t:"exit"} | {t:"info", d}

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const PORT = process.env.PORT || 8081;
const SESSIONS_VOLUME = process.env.SESSIONS_VOLUME || "interview-pad_pty-sessions";
const SESSIONS_DIR = process.env.SESSIONS_DIR || "/sessions";
const IDLE_KILL_MS = 90_000; // kill the shell this long after the last client leaves
const SCROLLBACK_BYTES = 256 * 1024;

// Invisible OSC marker printed after a run command completes; xterm ignores
// unknown OSC sequences, so it never shows, but ptyd detects it to know the
// program finished (drives the Run button's "Running" state).
const DONE_MARKER = "\x1b]777;ipdone\x07";
const DONE_PRINTF = "; printf '\\033]777;ipdone\\007'\r";

// language id (Monaco) -> shell image + how to run a file in it.
// `debian`/`alpine` decides which shell binary the container has.
const LANGS = {
  python: { image: "python:3.12-slim", shell: ["bash", "--norc"], file: "main.py", cmd: (f) => `python3 -u /code/${f}` },
  javascript: { image: "node:22-alpine", shell: ["sh"], file: "main.js", cmd: (f) => `node /code/${f}` },
  typescript: { image: "interview-pad-ts:local", shell: ["bash", "--norc"], file: "main.ts", cmd: (f) => `tsx /code/${f}` },
  java: {
    image: "eclipse-temurin:21-jdk",
    shell: ["bash", "--norc"],
    // File name must match the public class, so derive both from the code.
    resolve: (code) => {
      const m =
        code.match(/public\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/) ||
        code.match(/\bclass\s+([A-Za-z_$][\w$]*)/);
      const cls = m ? m[1] : "Main";
      return { file: `${cls}.java`, cmd: `cd /code && javac ${cls}.java -d /tmp && java -cp /tmp ${cls}` };
    },
  },
  go: { image: "golang:1.22-alpine", shell: ["sh"], file: "main.go", cmd: () => `cd /code && go run main.go` },
  c: { image: "gcc:14", shell: ["bash", "--norc"], file: "main.c", cmd: (f) => `gcc /code/${f} -o /tmp/a && /tmp/a` },
  cpp: { image: "gcc:14", shell: ["bash", "--norc"], file: "main.cpp", cmd: (f) => `g++ -O2 /code/${f} -o /tmp/a && /tmp/a` },
};

const sessions = new Map();

function sanitizeId(raw) {
  const id = String(raw || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return id.length ? id : null;
}

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { clients: new Set(), pty: null, container: null, lang: null, buffer: "", tail: "", startedAt: 0, idleTimer: null, cols: 80, rows: 24 };
    sessions.set(id, s);
  }
  return s;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(s, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of s.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}
function appendBuffer(s, data) {
  s.buffer += data;
  if (s.buffer.length > SCROLLBACK_BYTES) s.buffer = s.buffer.slice(-SCROLLBACK_BYTES);
}

function stopShell(s) {
  const container = s.container;
  if (s.pty) { try { s.pty.kill(); } catch {} s.pty = null; }
  s.container = null;
  s.lang = null;
  if (container) execFile("docker", ["kill", container], () => {});
}

let counter = 0;

// Start (or restart) the pad's shell container for a language.
function startShell(id, s, lang) {
  const spec = LANGS[lang];
  if (!spec) return;
  stopShell(s);

  const dir = path.join(SESSIONS_DIR, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
  try { fs.chmodSync(dir, 0o777); } catch {}

  const container = `pad_${id}_${++counter}`;
  const args = [
    "run", "--rm", "-i", "-t",
    "--name", container,
    "--network", "none",
    "--memory", "512m", "--memory-swap", "512m",
    "--pids-limit", "256",
    "--cpus", "1.5",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", "1000:1000",
    "--mount", `type=volume,src=${SESSIONS_VOLUME},dst=/code,volume-subpath=${id}`,
    "-w", "/code",
    "--tmpfs", "/tmp:size=128m,exec,mode=1777",
    "-e", "HOME=/tmp",
    "-e", "GOCACHE=/code/.gocache",
    "-e", "GOFLAGS=-mod=mod",
    "-e", "PYTHONDONTWRITEBYTECODE=1",
    "-e", "PS1=$ ",
    "-e", "TERM=xterm-256color",
    spec.image, ...spec.shell,
  ];

  const term = pty.spawn("docker", args, { name: "xterm-256color", cols: s.cols, rows: s.rows, env: process.env });
  s.pty = term;
  s.container = container;
  s.lang = lang;
  s.tail = "";
  s.startedAt = Date.now();

  term.onData((data) => {
    appendBuffer(s, data);
    broadcast(s, { t: "out", d: data });
    // Detect the invisible run-complete marker (may span chunks). Check the
    // full combined buffer before truncating so a marker followed by more data
    // in the same chunk isn't missed.
    const combined = s.tail + data;
    if (combined.includes(DONE_MARKER)) broadcast(s, { t: "exit" });
    s.tail = combined.slice(-(DONE_MARKER.length - 1));
  });
  term.onExit(() => {
    if (s.pty === term) { s.pty = null; s.lang = null; }
    broadcast(s, { t: "exit" });
  });
}

function ensureShell(id, s, lang) {
  if (!s.pty || s.lang !== lang) startShell(id, s, lang);
}

function runCode(id, s, lang, code) {
  const spec = LANGS[lang];
  if (!spec) {
    broadcast(s, { t: "info", d: `\r\n\x1b[90m[${lang} isn't runnable]\x1b[0m\r\n` });
    return;
  }
  const resolved = spec.resolve ? spec.resolve(code) : { file: spec.file, cmd: spec.cmd(spec.file) };
  fs.writeFileSync(path.join(SESSIONS_DIR, id, resolved.file), code, { mode: 0o666 });

  const fresh = !s.pty || s.lang !== lang;
  ensureShell(id, s, lang);

  // Ctrl-U clears any partial input, then run + the completion marker.
  const inject = "\x15" + resolved.cmd + DONE_PRINTF;
  // A freshly started shell needs a moment before it reads stdin.
  if (fresh) setTimeout(() => { if (s.pty) s.pty.write(inject); }, 900);
  else s.pty.write(inject);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const id = sanitizeId((req.url || "").split("?")[0].replace(/^\/+/, ""));
  if (!id) { ws.close(1008, "bad session id"); return; }

  const s = getSession(id);
  s.clients.add(ws);
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }

  if (s.buffer) send(ws, { t: "out", d: s.buffer }); // replay screen to late joiners

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === "shell") {
      s.cols = m.cols || s.cols;
      s.rows = m.rows || s.rows;
      ensureShell(id, s, String(m.lang || ""));
    } else if (m.t === "run") {
      s.cols = m.cols || s.cols;
      s.rows = m.rows || s.rows;
      runCode(id, s, String(m.lang || ""), String(m.code ?? ""));
    } else if (m.t === "in") {
      if (s.pty) s.pty.write(m.d);
    } else if (m.t === "resize") {
      s.cols = m.cols || s.cols;
      s.rows = m.rows || s.rows;
      if (s.pty) { try { s.pty.resize(s.cols, s.rows); } catch {} }
    } else if (m.t === "clear") {
      s.buffer = "";
      broadcast(s, { t: "out", d: "\x1b[2J\x1b[3J\x1b[H" });
    } else if (m.t === "stop") {
      if (s.pty) s.pty.write("\x03"); // Ctrl-C interrupts the running program
    }
  });

  ws.on("close", () => {
    s.clients.delete(ws);
    if (s.clients.size === 0) {
      s.idleTimer = setTimeout(() => {
        stopShell(s);
        sessions.delete(id);
      }, IDLE_KILL_MS);
    }
  });
});

server.listen(PORT, () => console.log(`ptyd listening on :${PORT}`));
