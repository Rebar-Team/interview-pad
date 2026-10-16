export type Answer = {
  message: string;
  /** Context-anchored patch; see proposal.ts. */
  patch: string | null;
  cached_tokens: number;
};

export class AssistantError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Same-origin Rust API. No credentials or model configuration in the browser. */
export class AssistantClient {
  private controller?: AbortController;

  cancel() {
    this.controller?.abort();
  }

  async request(operation: "chat" | "reset", body: object): Promise<Answer> {
    this.controller = new AbortController();
    // Above the server's worst case (a 60s call, plus one retry if the first
    // finished within 30s).
    const timeout = window.setTimeout(() => this.cancel(), 120_000);
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
        throw new AssistantError(
          response.status,
          (data.error || "Interview Assistant is unavailable.").replace(
            /\bLuna\b/g,
            "Interview Assistant",
          ),
        );
      return data;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError")
        throw new Error("The Interview Assistant took too long. Try again.");
      throw e;
    } finally {
      window.clearTimeout(timeout);
    }
  }
}
