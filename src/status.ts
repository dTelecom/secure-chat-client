// Sender-side per-message status state machine.
//
//   sent          : the local node accepted at least one target's chatSend
//                   (chatSendResult: live | stored).
//   delivered     : at least one peer device returned a `received` event.
//   deliveredAll  : every peer device the sender knows about returned
//                   `received`.
//   read          : a `read` event with upToId >= this message arrived.
//
// The tracker is in-memory only — status is reconstructable from the
// store + events on next connect. The SDK emits `statusChange` to the app
// on every transition.

export type MessageStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "deliveredAll"
  | "read";

interface Outbound {
  messageId: string;
  peerUserId: string;
  /** envelopeUuid → peerDeviceId */
  envelopeToDevice: Map<string, string>;
  /** Peer device ids the sender thinks the recipient has, at send time. */
  peerDevices: Set<string>;
  /** Peer device ids that have returned a `received` for this message. */
  receivedFrom: Set<string>;
  status: MessageStatus;
}

export type StatusListener = (
  messageId: string,
  status: MessageStatus,
  peerUserId: string,
) => void;

export class StatusTracker {
  private outbound = new Map<string, Outbound>();
  /** Reverse index for quick lookup on chatSendResult. */
  private envelopeToMessage = new Map<string, string>();
  /** Sorted list of (messageId, peerUserId) ordered by send time, used to
   *  resolve `read` watermarks against earlier messages. Append-only. */
  private byPeer = new Map<string, string[]>();

  private listeners: StatusListener[] = [];

  on(fn: StatusListener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * Register a freshly-sent message. envelopeToDevice maps each target's
   * envelopeUuid to the peer device it was sent to — fed by the SDK from
   * the chatSend frame's targets[].
   */
  trackOutbound(opts: {
    messageId: string;
    peerUserId: string;
    envelopeToDevice: Map<string, string>;
  }): void {
    const peerDevices = new Set(opts.envelopeToDevice.values());
    this.outbound.set(opts.messageId, {
      messageId: opts.messageId,
      peerUserId: opts.peerUserId,
      envelopeToDevice: opts.envelopeToDevice,
      peerDevices,
      receivedFrom: new Set(),
      status: "pending",
    });
    for (const uuid of opts.envelopeToDevice.keys()) {
      this.envelopeToMessage.set(uuid, opts.messageId);
    }
    const list = this.byPeer.get(opts.peerUserId) ?? [];
    list.push(opts.messageId);
    this.byPeer.set(opts.peerUserId, list);
  }

  /**
   * Process a chatSendResult outcome. Multiple outcomes per message (one
   * per target). Marks the message at least "sent" once any target
   * succeeds.
   */
  onSendResult(envelopeUuid: string, status: "live" | "stored" | "dropped" | "error"): void {
    const messageId = this.envelopeToMessage.get(envelopeUuid);
    if (!messageId) return;
    const outbound = this.outbound.get(messageId);
    if (!outbound) return;
    if (status === "live" || status === "stored") {
      this.bump(outbound, "sent");
    }
    // dropped/error: leave status alone — caller might retry from the outbox.
  }

  /**
   * Process an inbound `received` event from peer. Marks corresponding
   * outbound messages as delivered (or deliveredAll once all peer
   * devices have acknowledged).
   */
  onReceived(opts: {
    peerUserId: string;
    peerDeviceId: string;
    messageIds: string[];
  }): void {
    for (const id of opts.messageIds) {
      const outbound = this.outbound.get(id);
      if (!outbound) continue;
      if (outbound.peerUserId !== opts.peerUserId) continue;
      if (!outbound.peerDevices.has(opts.peerDeviceId)) {
        // Sender's device list was stale at send time; still count it.
        outbound.peerDevices.add(opts.peerDeviceId);
      }
      outbound.receivedFrom.add(opts.peerDeviceId);
      const allReceived =
        outbound.receivedFrom.size >= outbound.peerDevices.size && outbound.peerDevices.size > 0;
      this.bump(outbound, allReceived ? "deliveredAll" : "delivered");
    }
  }

  /**
   * Process a `read` watermark from the peer. All this peer's outbound
   * messages with sentAt index <= upToId's index move to "read".
   * Resolution is by send-order (insertion order in byPeer).
   */
  onRead(opts: { peerUserId: string; upToId: string }): void {
    const list = this.byPeer.get(opts.peerUserId);
    if (!list) return;
    const idx = list.indexOf(opts.upToId);
    if (idx < 0) return;
    for (let i = 0; i <= idx; i++) {
      const outbound = this.outbound.get(list[i]);
      if (!outbound) continue;
      this.bump(outbound, "read");
    }
  }

  /** Test/diagnostic helper. */
  getStatus(messageId: string): MessageStatus | undefined {
    return this.outbound.get(messageId)?.status;
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private bump(outbound: Outbound, candidate: MessageStatus): void {
    if (rank(candidate) <= rank(outbound.status)) return;
    outbound.status = candidate;
    for (const fn of this.listeners) {
      try {
        fn(outbound.messageId, candidate, outbound.peerUserId);
      } catch {
        // Listener errors must not break the tracker.
      }
    }
  }
}

function rank(s: MessageStatus): number {
  switch (s) {
    case "pending":
      return 0;
    case "sent":
      return 1;
    case "delivered":
      return 2;
    case "deliveredAll":
      return 3;
    case "read":
      return 4;
  }
}
