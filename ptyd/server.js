// ptyd — interactive PTY runner for InterviewPad.
//
// One shared pseudo-terminal per pad. On a "run" message we (re)launch the
// pad's current code inside a locked-down sibling container attached to a PTY,
// and stream its terminal both ways over WebSocket. Every socket on the same
// pad id shares the same terminal: all see the output, any can type.
//
// Protocol (JSON, both directions):
//   client -> server: {t:"run", lang, code} | {t:"in", d} | {t:"resize", cols, rows}
//   server -> client: {t:"out", d} | {t:"exit", code} | {t:"info", d}

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const PORT = process.env.PORT || 8081;
// A named docker volume shared with each run container via a per-pad subpath.
// ptyd mounts it at /sessions; children mount <subpath> at /code.
const SESSIONS_VOLUME = process.env.SESSIONS_VOLUME || "interview-pad_pty-sessions";
const SESSIONS_DIR = process.env.SESSIONS_DIR || "/sessions";
const IDLE_KILL_MS = 60_000; // kill a run this long after the last client leaves
const MAX_RUN_MS = 60 * 60_000; // hard lifetime cap per run
const SCROLLBACK_BYTES = 256 * 1024; // replayed to late joiners

// language id (Monaco) -> { image, ext, cmd }. cmd runs inside the container;
// compiled langs compile then exec in the same TTY. All images are self-contained
// so runs work with --network none.
const LANGS = {
  python: { image: "python:3.12-slim", ext: "py", cmd: ["python3", "-u", "/code/main.py"] },
  javascript: { image: "node:22-alpine", ext: "js", cmd: ["node", "/code/main.js"] },
  // Built locally (tsx preinstalled) so TypeScript runs offline. See runtimes/typescript.
  typescript: { image: "interview-pad-ts:local", ext: "ts", cmd: ["tsx", "/code/main.ts"] },
  // Java expects the public class to be named Main; we always write Main.java.
  java: { image: "eclipse-temurin:21-jdk", ext: "java", file: "Main.java", cmd: ["sh", "-c", "cd /code && javac Main.java -d /tmp && exec java -cp /tmp Main"] },
  go: { image: "golang:1.22-alpine", ext: "go", cmd: ["sh", "-c", "cd /code && go run main.go"] },
  c: { image: "gcc:14", ext: "c", cmd: ["sh", "-c", "gcc /code/main.c -o /tmp/a.out && exec /tmp/a.out"] },
  cpp: { image: "gcc:14", ext: "cpp", cmd: ["sh", "-c", "g++ -O2 /code/main.cpp -o /tmp/a.out && exec /tmp/a.out"] },
};

const sessions = new Map(); // id -> { clients:Set<ws>, pty, container, buffer, idleTimer, lifeTimer, cols, rows }

function sanitizeId(raw) {
  const id = String(raw || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return id.length ? id : null;
}

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { clients: new Set(), pty: null, container: null, buffer: "", idleTimer: null, lifeTimer: null, cols: 80, rows: 24 };
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

function stopRun(s) {
  if (s.lifeTimer) { clearTimeout(s.lifeTimer); s.lifeTimer = null; }
  const container = s.container;
  if (s.pty) { try { s.pty.kill(); } catch {} s.pty = null; }
  s.container = null;
  // Ensure the sibling container is gone even if killing the client didn't stop it.
  if (container) execFile("docker", ["kill", container], () => {});
}

let runCounter = 0;

function startRun(id, s, lang, code) {
  const spec = LANGS[lang];
  if (!spec) {
    broadcast(s, { t: "info", d: `\r\n[interview-pad] "${lang}" isn't runnable here.\r\n` });
    return;
  }
  stopRun(s);

  // Write the code into the shared sessions volume under this pad's subpath.
  const dir = path.join(SESSIONS_DIR, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
  try { fs.chmodSync(dir, 0o777); } catch {}
  const filename = spec.file || `main.${spec.ext}`;
  fs.writeFileSync(path.join(dir, filename), code, { mode: 0o666 });

  const container = `pad_${id}_${++runCounter}`;
  s.container = container;
  s.buffer = "";
  broadcast(s, { t: "info", d: "\x1b[2J\x1b[H" }); // clear terminals

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
    "-e", "GOCACHE=/tmp/.gocache",
    "-e", "GOFLAGS=-mod=mod",
    "-e", "PYTHONDONTWRITEBYTECODE=1",
    spec.image, ...spec.cmd,
  ];

  const term = pty.spawn("docker", args, {
    name: "xterm-color",
    cols: s.cols,
    rows: s.rows,
    cwd: "/tmp",
    env: process.env,
  });
  s.pty = term;

  term.onData((data) => { appendBuffer(s, data); broadcast(s, { t: "out", d: data }); });
  term.onExit(({ exitCode }) => {
    if (s.pty === term) s.pty = null;
    broadcast(s, { t: "exit", code: exitCode });
  });

  s.lifeTimer = setTimeout(() => {
    broadcast(s, { t: "info", d: "\r\n[interview-pad] run exceeded time limit; stopped.\r\n" });
    stopRun(s);
  }, MAX_RUN_MS);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  // Caddy strips the /pty prefix, so the path is /<padId>.
  const id = sanitizeId((req.url || "").split("?")[0].replace(/^\/+/, ""));
  if (!id) { ws.close(1008, "bad session id"); return; }

  const s = getSession(id);
  s.clients.add(ws);
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }

  // Replay current screen to a late joiner.
  if (s.buffer) send(ws, { t: "out", d: s.buffer });

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === "run") {
      s.cols = m.cols || s.cols;
      s.rows = m.rows || s.rows;
      startRun(id, s, String(m.lang || ""), String(m.code ?? ""));
    } else if (m.t === "in") {
      if (s.pty) s.pty.write(m.d);
    } else if (m.t === "resize") {
      s.cols = m.cols || s.cols;
      s.rows = m.rows || s.rows;
      if (s.pty) { try { s.pty.resize(s.cols, s.rows); } catch {} }
    }
  });

  ws.on("close", () => {
    s.clients.delete(ws);
    if (s.clients.size === 0) {
      s.idleTimer = setTimeout(() => {
        stopRun(s);
        sessions.delete(id);
      }, IDLE_KILL_MS);
    }
  });
});

server.listen(PORT, () => console.log(`ptyd listening on :${PORT}`));
