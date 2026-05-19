// WebSocket client for /chat/ws. JSON frames per chat-wire-contract.md §3.
// Auto-reconnect with exponential backoff. Token attached via the
// `?access_token=` query param (browsers can't set headers on WS upgrade).

import type {
  ChatEnvelopeAckFrame,
  ChatPingFrame,
  ChatSendFrame,
  InboundFrame,
  OutboundFrame,
} from "../types.js";

export type WsState = "connecting" | "open" | "closing" | "closed" | "reconnecting";

export interface WsClientOptions {
  /** Full WebSocket URL including scheme, e.g. "wss://node.test.dtelecom.org" */
  nodeBaseURL: string;
  /** Returns the chat-token JWT to attach as ?access_token=… */
  getToken: () => Promise<string>;
  /** Called for each inbound frame (already JSON-parsed and discriminated). */
  onFrame: (frame: InboundFrame) => unknown;
  /** Called when the connection state changes. */
  onState?: (state: WsState) => void;
  /** Optional WebSocket constructor (defaults to globalThis.WebSocket). */
  webSocketImpl?: typeof WebSocket;
  /** Auto-reconnect on close (default true). Disable for one-shot tests. */
  reconnect?: boolean;
  /** Send a chatPing every N ms while open (default 25_000; 0 disables). */
  pingIntervalMs?: number;
}

export class WsClient {
  private opts: Required<Omit<WsClientOptions, "webSocketImpl">> & {
    webSocketImpl: typeof WebSocket;
  };
  private socket: WebSocket | null = null;
  private state: WsState = "closed";
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private explicitClose = false;

  constructor(opts: WsClientOptions) {
    this.opts = {
      nodeBaseURL: opts.nodeBaseURL.replace(/\/$/, ""),
      getToken: opts.getToken,
      onFrame: opts.onFrame,
      onState: opts.onState ?? (() => {}),
      webSocketImpl: opts.webSocketImpl ?? (globalThis.WebSocket as typeof WebSocket),
      reconnect: opts.reconnect ?? true,
      pingIntervalMs: opts.pingIntervalMs ?? 25_000,
    };
  }

  getState(): WsState {
    return this.state;
  }

  /** Open a connection. Resolves once the WS reaches `open`. */
  async connect(): Promise<void> {
    if (this.state === "open" || this.state === "connecting") return;
    this.explicitClose = false;
    return this.connectInternal();
  }

  /** Send an outbound frame. Throws if not open. */
  send(frame: OutboundFrame): void {
    if (!this.socket || this.state !== "open") {
      throw new Error(`ws not open (state=${this.state})`);
    }
    this.socket.send(JSON.stringify(frame));
  }

  /** Convenience for a chatSend frame. */
  sendChat(frame: Omit<ChatSendFrame, "kind">): void {
    this.send({ kind: "chatSend", ...frame });
  }

  /**
   * Convenience for a chatEnvelopeAck frame — fire-and-forget. The SDK
   * sends this after it has durably stored an inbound envelope (post
   * `messages.put`). If the WS isn't open the call swallows silently:
   * the node's sender-side retry / webhook-fallback path is the recovery
   * mechanism, not WS-level retry from the receiver.
   */
  sendEnvelopeAck(frame: Omit<ChatEnvelopeAckFrame, "kind">): void {
    if (this.state !== "open") return;
    try {
      this.send({ kind: "chatEnvelopeAck", ...frame });
    } catch {
      // not open mid-call; ignore — sender will timeout + webhook
    }
  }

  /** Convenience for a chatPing. */
  ping(): void {
    const f: ChatPingFrame = { kind: "chatPing" };
    this.send(f);
  }

  /** Close the connection. After this, no auto-reconnect happens. */
  async close(): Promise<void> {
    this.explicitClose = true;
    this.setState("closing");
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.socket && this.socket.readyState === this.opts.webSocketImpl.OPEN) {
      this.socket.close(1000, "client closing");
    }
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private async connectInternal(): Promise<void> {
    this.setState("connecting");
    const token = await this.opts.getToken();
    const url = `${this.opts.nodeBaseURL}/chat/ws?access_token=${encodeURIComponent(token)}`;
    const Ctor = this.opts.webSocketImpl;
    const sock = new Ctor(url);
    this.socket = sock;

    return new Promise<void>((resolve, reject) => {
      sock.onopen = () => {
        this.attempt = 0;
        this.setState("open");
        this.startPing();
        resolve();
      };
      sock.onmessage = (ev: MessageEvent) => {
        let frame: InboundFrame;
        try {
          frame = JSON.parse(typeof ev.data === "string" ? ev.data : "") as InboundFrame;
        } catch {
          return; // ignore malformed
        }
        try {
          const ret = this.opts.onFrame(frame);
          // Catch async rejections too — some consumers' onFrame returns a
          // Promise (e.g. SDK's async handler chain). Without this, an
          // inbound message that triggers an internal failure would surface
          // as an UnhandledPromiseRejection on the process.
          if (ret && typeof (ret as Promise<unknown>).catch === "function") {
            (ret as Promise<unknown>).catch(() => {});
          }
        } catch {
          // user handler errors must not break the read loop
        }
      };
      sock.onerror = (_ev: Event) => {
        // The error event itself rarely has actionable info — onclose is what
        // we react to. If the connect hasn't resolved yet, surface as reject.
        if (this.state === "connecting") reject(new Error("ws connect error"));
      };
      sock.onclose = () => {
        this.stopPing();
        this.socket = null;
        if (this.explicitClose || !this.opts.reconnect) {
          this.setState("closed");
          return;
        }
        this.setState("reconnecting");
        const delay = backoffMs(this.attempt++);
        setTimeout(() => {
          // best-effort; new failure repeats the cycle
          this.connectInternal().catch(() => {});
        }, delay);
      };
    });
  }

  private startPing(): void {
    if (this.opts.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      try {
        this.ping();
      } catch {
        // not open; the read loop will reconnect
      }
    }, this.opts.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setState(s: WsState): void {
    if (this.state === s) return;
    this.state = s;
    try {
      this.opts.onState(s);
    } catch {
      // never let listener errors propagate
    }
  }
}

function backoffMs(attempt: number): number {
  // 0.5s, 1s, 2s, 4s, 8s, capped at 30s. With ±20% jitter.
  const base = Math.min(500 * 2 ** attempt, 30_000);
  const jitter = base * (0.2 * (Math.random() - 0.5) * 2);
  return Math.max(250, Math.floor(base + jitter));
}
