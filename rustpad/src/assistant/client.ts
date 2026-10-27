/** One message in a room's shared assistant chat. */
export type ChatMessage = {
  id: number;
  createdAt: number;
  /** Who asked; empty for the assistant. */
  author: string;
  role: "user" | "assistant";
  kind: "question" | "edit" | "clarify" | "answer" | "error";
  content: string;
  /** Context-anchored patch, applied by the server; see proposal.ts. */
  patch: string | null;
  /** A note from the server, such as why an edit isn't shown. */
  notice: string | null;
  appliedBy: string | null;
};

export type ChatEvent =
  | { type: "snapshot"; messages: ChatMessage[]; busy: string | null }
  | { type: "message"; message: ChatMessage }
  | { type: "busy"; busy: string | null }
  | { type: "cleared" }
  /** `request` is the failed request's type, e.g. "ask" or "apply". */
  | { type: "error"; error: string; request: string | null };

export type ChatRequest =
  | {
      type: "ask";
      message: string;
      code: string;
      language: string;
      cursor?: { line: number; selection: string };
      author: string;
    }
  | { type: "clear" }
  /** The server applies the edit to the shared code, once. */
  | { type: "apply"; id: number; author: string }
  | { type: "undo"; id: number };

/**
 * The room's shared chat over a same-origin WebSocket, like the editor and
 * terminal. Reconnects with backoff; each connection starts with a snapshot.
 * No credentials or model configuration in the browser.
 */
export class AssistantSocket {
  private socket?: WebSocket;
  private disposed = false;
  private retries = 0;
  private timer?: number;
  private readonly padId: string;
  private readonly onEvent: (event: ChatEvent) => void;
  private readonly onConnected: (connected: boolean) => void;

  constructor(
    padId: string,
    onEvent: (event: ChatEvent) => void,
    onConnected: (connected: boolean) => void,
  ) {
    this.padId = padId;
    this.onEvent = onEvent;
    this.onConnected = onConnected;
    this.open();
  }

  private open() {
    const url = new URL(
      `/api/assistant/${encodeURIComponent(this.padId)}`,
      window.location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.retries = 0;
      this.onConnected(true);
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      try {
        this.onEvent(JSON.parse(message.data));
      } catch {
        // Not a chat event; ignore it.
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket || this.disposed) return;
      this.onConnected(false);
      const delay = Math.min(1000 * 2 ** this.retries++, 10_000);
      this.timer = window.setTimeout(() => this.open(), delay);
    };
  }

  /** False when not connected; the caller should say so. */
  send(request: ChatRequest): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(request));
    return true;
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.timer);
    this.socket?.close();
  }
}

/** Apply an event to the chat, keeping messages in order and unique by ID. */
export function applyEvent(
  messages: ChatMessage[],
  event: ChatEvent,
): ChatMessage[] {
  switch (event.type) {
    case "snapshot":
      return event.messages;
    case "cleared":
      return [];
    case "message": {
      const at = messages.findIndex((m) => m.id === event.message.id);
      if (at === -1) return [...messages, event.message];
      const next = messages.slice();
      next[at] = event.message;
      return next;
    }
    default:
      return messages;
  }
}
