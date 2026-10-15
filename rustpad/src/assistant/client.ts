export type Edit = { before: string; after: string };
export type Answer = {
  message: string;
  edit: Edit | null;
  cached_tokens: number;
};

/** Same-origin Rust API. No credentials or model configuration in the browser. */
export class AssistantClient {
  private controller?: AbortController;

  cancel() {
    this.controller?.abort();
  }

  async request(operation: "chat" | "reset", body: object): Promise<Answer> {
    this.controller = new AbortController();
    const timeout = window.setTimeout(() => this.cancel(), 70_000);
    try {
      const response = await fetch(`/api/assistant/${operation}`, {
        method: "POST",
        credentials: "same-origin",
        signal: this.controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new Error("Assistant request rejected by the server.");
      }
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          (data.error || "Interview Assistant is unavailable.").replace(
            /\bLuna\b/g,
            "Interview Assistant",
          ),
        );
      return data;
    } finally {
      window.clearTimeout(timeout);
    }
  }
}
