// Sender-side per-message status state machine.
//
//   pending       : queued in the outbox, no result yet.
//   sent          : the local node accepted at least one target's chatSend
//                   (chatSendResult: live | stored).
//   delivered     : at least one peer device returned a `received` event.
//   deliveredAll  : every peer device the sender knows about returned
//                   `received`.
//   read          : a `read` event with upToId >= this message arrived.
//   failed        : Outbox gave up after max retries. Terminal — no further
//                   transitions for this messageId.
//
// The tracker itself is in-memory; the SDK mirrors every transition into
// `StoredMessage.status` (see message_store.ts) so the last-known state
// survives reload.

export type MessageStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "deliveredAll"
  | "read"
  | "failed";

interface Outbound {
  messageId: string;
  peerUserId: string;
  /** envelopeUuid → peerDeviceId */
  envelopeToDevice: Map<string, string>;
  /** Peer device ids the sender thinks the recipient has, at send time. */
  peerDevices: Set<string>;
  /** Peer device ids that have returned a `received` for this message. */
  receivedFrom: Set<string>;
  /** Total number of per-target envelopes the SDK shipped. Captured at
   *  trackOutbound time; used to detect "every target errored" so we can
   *  downgrade to "failed" without acking-away partial successes. */
  totalEnvelopes: number;
  /** envelopeUuids whose chatSendResult returned "error". When this set's
   *  size === totalEnvelopes the whole message has been rejected by the
   *  node for every target and downgrades to "failed". */
  erroredEnvelopes: Set<string>;
  status: MessageStatus;
}

export type StatusListener = (
  messageId: string,
  status: MessageStatus,
  peerUserId: string,
) => void;

/** Per-peer cap on each pending-event buffer (received and read).
 *  Bounds memory if peer sends an unbounded stream of acks for
 *  messageIds we'll never see (compromised peer, protocol bug, etc.).
 *  FIFO eviction — the oldest unresolved event is dropped first.
 *  100 entries × ~50 bytes per entry × N peers is bounded enough. */
const PENDING_BUFFER_CAP = 100;

export class StatusTracker {
  private outbound = new Map<string, Outbound>();
  /** Reverse index for quick lookup on chatSendResult. */
  private envelopeToMessage = new Map<string, string>();
  /** Sorted list of (messageId, peerUserId) ordered by send time, used to
   *  resolve `read` watermarks against earlier messages. Append-only. */
  private byPeer = new Map<string, string[]>();

  /** Buffered `received` events that arrived before `trackOutbound` had
   *  registered the messageId on this device. The fanout race is
   *  specific to sibling devices: selfEcho text (which triggers
   *  trackOutbound) and peer's received/read events arrive
   *  independently and can be reordered by the mesh. Without this
   *  buffer, onReceived found no outbound entry → silent skip → the
   *  ack was lost forever, and the row stayed at whatever earlier
   *  status it had. Keyed by peerUserId; entries replayed by
   *  trackOutbound for the matching peer. */
  private pendingReceivedsForUnknown = new Map<
    string,
    Array<{ peerDeviceId: string; messageId: string }>
  >();
  /** Same idea for `read` events. Keyed by peerUserId → list of
   *  unresolved upToIds. */
  private pendingReadsForUnknown = new Map<string, string[]>();

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
      totalEnvelopes: opts.envelopeToDevice.size,
      erroredEnvelopes: new Set(),
      status: "pending",
    });
    for (const uuid of opts.envelopeToDevice.keys()) {
      this.envelopeToMessage.set(uuid, opts.messageId);
    }
    const list = this.byPeer.get(opts.peerUserId) ?? [];
    list.push(opts.messageId);
    this.byPeer.set(opts.peerUserId, list);

    // Drain any buffered peer events for this peer. They arrived
    // before the messageId was registered (sibling fanout race) and
    // were saved for replay. Drain received first so the status
    // ladder advances through delivered → read in the same order as
    // the happy path. The dequeue-then-replay shape avoids infinite
    // recursion: anything that re-buffers during replay starts from
    // an empty queue.
    const queuedReceived = this.pendingReceivedsForUnknown.get(opts.peerUserId);
    if (queuedReceived) {
      this.pendingReceivedsForUnknown.delete(opts.peerUserId);
      for (const entry of queuedReceived) {
        this.onReceived({
          peerUserId: opts.peerUserId,
          peerDeviceId: entry.peerDeviceId,
          messageIds: [entry.messageId],
        });
      }
    }
    const queuedReads = this.pendingReadsForUnknown.get(opts.peerUserId);
    if (queuedReads) {
      this.pendingReadsForUnknown.delete(opts.peerUserId);
      for (const upToId of queuedReads) {
        this.onRead({ peerUserId: opts.peerUserId, upToId });
      }
    }
  }

  /**
   * Process a chatSendResult outcome. Multiple outcomes per message (one
   * per target). Marks the message at least "sent" once any target
   * succeeds. ALL targets returning "error" → downgrade to "failed",
   * but only from "pending" / "sent" — once any target has delivered
   * or read on the recipient side, the message clearly landed and a
   * late error frame for another target shouldn't roll the status back.
   */
  onSendResult(envelopeUuid: string, status: "live" | "stored" | "dropped" | "error"): void {
    const messageId = this.envelopeToMessage.get(envelopeUuid);
    if (!messageId) return;
    const outbound = this.outbound.get(messageId);
    if (!outbound) return;
    if (status === "live" || status === "stored") {
      this.bump(outbound, "sent");
      return;
    }
    if (status === "error") {
      outbound.erroredEnvelopes.add(envelopeUuid);
      const everyTargetErrored =
        outbound.erroredEnvelopes.size >= outbound.totalEnvelopes &&
        outbound.totalEnvelopes > 0;
      if (!everyTargetErrored) return;
      // All targets rejected by the node. Only downgrade from a
      // pre-delivery state — if the receiver side already moved the
      // status forward via a `received` / `read` event, the message
      // clearly landed for at least one device and the late "error"
      // is irrelevant to overall outcome.
      if (outbound.status === "pending" || outbound.status === "sent") {
        this.forceSet(outbound, "failed");
      }
      return;
    }
    // dropped: ephemeral envelope dropped on no-ack — does not apply
    // to non-ephemeral status tracking. No-op.
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
      if (!outbound) {
        // No outbound entry yet — the sibling device may receive
        // peer's `received` before the selfEcho text that triggers
        // trackOutbound (mesh fanout race). Buffer for replay; the
        // entry is replayed in trackOutbound for this peer.
        this.bufferReceived(opts.peerUserId, opts.peerDeviceId, id);
        continue;
      }
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
    const idx = list ? list.indexOf(opts.upToId) : -1;
    if (idx < 0) {
      // upToId not in our outbound list yet — sibling devices can
      // receive peer's `read` before the selfEcho text that triggers
      // trackOutbound (mesh fanout race). Buffer for replay in
      // trackOutbound for this peer.
      this.bufferRead(opts.peerUserId, opts.upToId);
      return;
    }
    for (let i = 0; i <= idx; i++) {
      const outbound = this.outbound.get(list![i]);
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
    this.emit(outbound);
  }

  /**
   * Bypass-rank setter for the error-downgrade path. Used only from
   * onSendResult when every target's chatSendResult returned "error" —
   * the message is genuinely failed and the status must move backwards
   * along the ladder from "sent" to "failed". `bump` would silently
   * no-op because `rank("failed") > rank("sent")` numerically but the
   * direction conceptually downgrades from a delivery-attempting state.
   */
  private forceSet(outbound: Outbound, to: MessageStatus): void {
    if (outbound.status === to) return;
    outbound.status = to;
    this.emit(outbound);
  }

  private emit(outbound: Outbound): void {
    for (const fn of this.listeners) {
      try {
        fn(outbound.messageId, outbound.status, outbound.peerUserId);
      } catch {
        // Listener errors must not break the tracker.
      }
    }
  }

  /**
   * Append a `received` event to the per-peer replay queue. FIFO
   * eviction beyond PENDING_BUFFER_CAP so a peer pumping out acks for
   * messageIds we'll never see can't grow the buffer unboundedly.
   */
  private bufferReceived(peerUserId: string, peerDeviceId: string, messageId: string): void {
    const buf = this.pendingReceivedsForUnknown.get(peerUserId) ?? [];
    buf.push({ peerDeviceId, messageId });
    while (buf.length > PENDING_BUFFER_CAP) buf.shift();
    this.pendingReceivedsForUnknown.set(peerUserId, buf);
  }

  /**
   * Same FIFO-cap shape for `read` upToIds. Note: a buffered `read`
   * with upToId X stays in the buffer until trackOutbound runs for
   * THIS peer with ANY messageId — at which point we replay every
   * buffered upToId. If the buffered upToId still isn't resolvable
   * (its message hasn't reached us yet), it gets re-buffered by the
   * replayed onRead call.
   */
  private bufferRead(peerUserId: string, upToId: string): void {
    const buf = this.pendingReadsForUnknown.get(peerUserId) ?? [];
    buf.push(upToId);
    while (buf.length > PENDING_BUFFER_CAP) buf.shift();
    this.pendingReadsForUnknown.set(peerUserId, buf);
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
    case "failed":
      // Terminal but orthogonal to the delivery ladder — `bump` should
      // never set "failed", that's the SDK's job via a separate code path.
      // Give it a sentinel rank so a stray bump can't downgrade `read`.
      return 99;
  }
}
