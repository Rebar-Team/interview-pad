import WebSocket from "ws";

// The backend sends Room on connect and whenever the room locks. Keeping this
// connection alive also revokes terminals whose clients ignore the editor UI.
export function watchRoom(id, { onReady, onLock }, backend = process.env.RUSTPAD_URL || "http://rustpad:3030") {
  const url = new URL(`/api/socket/${encodeURIComponent(id)}`, backend);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, { handshakeTimeout: 5000 });
  let stopped = false;
  let confirmed = false;
  const timeout = setTimeout(lock, 5000);
  function lock() {
    if (stopped) return;
    stop();
    onLock();
  }
  function stop() {
    stopped = true;
    clearTimeout(timeout);
    socket.terminate();
  }
  socket.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { lock(); return; }
    if (!message.Room) return;
    if (!message.Room.writable || message.Room.ended) { lock(); return; }
    clearTimeout(timeout);
    if (!confirmed) { confirmed = true; onReady(); }
  });
  socket.on("error", lock);
  socket.on("close", lock);
  return stop;
}
