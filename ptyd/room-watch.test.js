import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { watchRoom } from "./room-watch.js";

async function fixture(t) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test("an active terminal is revoked when the interview ends", async (t) => {
  const { server, url } = await fixture(t);
  const connected = once(server, "connection");
  let ready = 0;
  let locked;
  const revoked = new Promise((resolve) => { locked = resolve; });
  const stop = watchRoom("room", { onReady: () => ready++, onLock: locked }, url);
  t.after(stop);
  const [socket] = await connected;
  socket.send(JSON.stringify({ Room: { writable: true, ended: false } }));
  // Echo a ping to establish that the initial Room was processed.
  const pong = once(socket, "pong");
  socket.ping();
  await pong;
  assert.equal(ready, 1);
  socket.send(JSON.stringify({ Room: { writable: false, ended: true } }));
  await revoked;
  assert.equal(ready, 1);
});

test("a stale terminal upgrade never becomes writable after ending", async (t) => {
  const { server, url } = await fixture(t);
  const connected = once(server, "connection");
  let ready = false;
  let locked;
  const revoked = new Promise((resolve) => { locked = resolve; });
  const stop = watchRoom("room", { onReady: () => { ready = true; }, onLock: locked }, url);
  t.after(stop);
  const [socket] = await connected;
  socket.send(JSON.stringify({ Room: { writable: false, ended: true } }));
  await revoked;
  assert.equal(ready, false);
});

test("losing the backend connection revokes the terminal", async (t) => {
  const { server, url } = await fixture(t);
  const connected = once(server, "connection");
  let locked;
  const revoked = new Promise((resolve) => { locked = resolve; });
  const stop = watchRoom("room", { onReady: () => {}, onLock: locked }, url);
  t.after(stop);
  const [socket] = await connected;
  socket.terminate();
  await revoked;
});

test("ptyd closes existing clients and refuses stale upgrades after ending", { timeout: 10000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const { default: WebSocket } = await import("ws");
  const { server, url } = await fixture(t);
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const process = spawn(globalThis.process.execPath, ["server.js"], {
    cwd: new URL(".", import.meta.url),
    env: { ...globalThis.process.env, PORT: String(port), RUSTPAD_URL: url },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => process.kill());
  await once(process.stdout, "data");
  let ended = false;
  let control;
  server.on("connection", (socket) => {
    control = socket;
    socket.send(JSON.stringify({ Room: { writable: !ended, ended } }));
  });
  const options = { headers: { "x-room-expires-at": String(Date.now() + 60000) } };
  const client = new WebSocket(`ws://127.0.0.1:${port}/room`, options);
  t.after(() => client.terminate());
  await once(client, "open");
  const output = once(client, "message");
  // This can arrive before the control connection is ready; it must be queued.
  client.send(JSON.stringify({ t: "clear" }));
  assert.equal(JSON.parse(String((await output)[0])).t, "out");
  const closed = once(client, "close");
  ended = true;
  control.send(JSON.stringify({ Room: { writable: false, ended: true } }));
  await closed;

  const late = new WebSocket(`ws://127.0.0.1:${port}/room`, options);
  t.after(() => late.terminate());
  const lateClosed = once(late, "close");
  const messages = [];
  late.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await once(late, "open");
  late.send(JSON.stringify({ t: "clear" }));
  await lateClosed;
  assert.equal(messages.filter((message) => message.t === "out").length, 0);
});
