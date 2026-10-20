function runtime() {
  if (typeof chrome === "undefined" || !chrome.runtime?.id)
    throw new Error(
      "Open Rove from its Chrome extension to use the workbench.",
    );
  return chrome.runtime;
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  if (options?.body != null && typeof options.body !== "string")
    throw new Error("Rove requests must use JSON.");
  options?.signal?.throwIfAborted();
  const header = JSON.stringify({ path, method: options?.method || "GET" });
  // Preserve serialized request bodies without another copy.
  let request =
    options?.body == null
      ? header
      : `${header.slice(0, -1)},"body":${options.body}}`;
  const port = runtime().connect({ name: "rove-rpc" });
  return new Promise<T>((resolve, reject) => {
    const chunks: string[] = [];
    let settled = false;
    const cleanup = () => {
      options?.signal?.removeEventListener("abort", abort);
      port.disconnect();
      chunks.length = 0;
      request = "";
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(
        new Error(
          "The request was cancelled before its result was confirmed. Check task history before trying the action again.",
        ),
      );
    options?.signal?.addEventListener("abort", abort, { once: true });
    port.onMessage.addListener(
      (message: { type: string; data?: string; error?: string }) => {
        if (settled) return;
        if (message.type === "error") {
          fail(
            new Error(message.error || "The action could not be completed."),
          );
        } else if (
          message.type === "chunk" &&
          typeof message.data === "string"
        ) {
          chunks.push(message.data);
        } else if (message.type === "end") {
          try {
            const value = JSON.parse(chunks.join("")) as T;
            settled = true;
            cleanup();
            resolve(value);
          } catch {
            fail(
              new Error(
                "The extension returned an unreadable result. Check task history before trying the action again.",
              ),
            );
          }
        }
      },
    );
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      fail(
        new Error(
          "The extension disconnected before confirming the result. The action may have completed. Check task history before trying it again.",
        ),
      );
    });
    void (async () => {
      try {
        for (
          let offset = 0;
          offset < request.length && !settled;
          offset += 1_000_000
        ) {
          port.postMessage({
            type: "chunk",
            data: request.slice(offset, offset + 1_000_000),
          });
          // Yield between batches so large history transfers do not block the workbench.
          if (offset && offset % 8_000_000 === 0)
            await new Promise<void>((done) => setTimeout(done, 0));
        }
        if (!settled) port.postMessage({ type: "end" });
      } catch {
        fail(
          new Error(
            "The request could not be sent completely. Check task history before trying the action again.",
          ),
        );
      }
    })();
  });
}

/** EventSource interface backed entirely by the extension's runtime event port. */
export class RuntimeEventSource {
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  private port: chrome.runtime.Port | null = null;
  private closed = false;
  private reconnect: ReturnType<typeof setTimeout> | undefined;

  constructor(_path = "/api/events") {
    queueMicrotask(() => this.connect());
  }

  private connect() {
    if (this.closed) return;
    try {
      const port = runtime().connect({ name: "rove-events" });
      this.port = port;
      port.onMessage.addListener(
        (message: { type?: string; data?: unknown }) => {
          if (this.closed || !message.type) return;
          const event = new MessageEvent(message.type, {
            data: JSON.stringify(message.data),
          });
          this.listeners
            .get(message.type)
            ?.forEach((listener) => listener(event));
        },
      );
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (this.port === port) this.port = null;
        if (!this.closed) {
          this.onerror?.(new Event("error"));
          this.reconnect = setTimeout(() => this.connect(), 1000);
        }
      });
      this.onopen?.(new Event("open"));
    } catch {
      this.onerror?.(new Event("error"));
      if (!this.closed) this.reconnect = setTimeout(() => this.connect(), 1500);
    }
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnect);
    this.port?.disconnect();
    this.port = null;
    this.listeners.clear();
  }
}

export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
