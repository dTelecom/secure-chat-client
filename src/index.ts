// Public SDK surface. Wires transport + crypto + content protocol behind
// a small event-emitter API. Most app code will only ever touch this file.

import { CONTENT_PROTOCOL_VERSION as _CONTENT_VERSION } from "./content/protocol.js";
import {
  decodeEventBytes,
  encodeEventBytes,
  newDelete,
  newEdit,
  newRead,
  newReceived,
  newSelfEcho,
  newText,
  newTyping,
  type SelfEchoableEvent,
  type ContentEvent,
} from "./content/protocol.js";
import type { CryptoAdapter } from "./crypto/interface.js";
import { OlmCryptoAdapter } from "./crypto/olm-adapter.js";
import { loadOrCreateDeviceId } from "./device.js";
import { PeerDeviceCache } from "./device_discovery.js";
import { KeyBundleManager } from "./key_bundle.js";
import { MessageStore, type StoredMessage } from "./message_store.js";
import { Outbox } from "./outbox.js";
import { SessionManager } from "./sessions.js";
import { StatusTracker, type MessageStatus } from "./status.js";
import type { KVStore } from "./store/interface.js";
import { WebKVStore } from "./store/web-adapter.js";
import { HttpClient, type FetchChatToken } from "./transport/http.js";
import { WsClient } from "./transport/ws.js";
import { TypingManager } from "./typing.js";
import type { ChatSendResult, ChatSendTarget, InboundFrame } from "./types.js";

export const VERSION = "0.0.0";
export const CONTENT_PROTOCOL_VERSION = _CONTENT_VERSION;

// ── public option types ─────────────────────────────────────────────────────

export interface ConnectOptions {
  /** dmeet-backend (or mock) base URL — e.g. https://dmeet.example.com */
  apiBaseURL: string;
  /** Function that mints a chat token. The SDK calls this whenever a fresh
   *  token is needed; the consumer's implementation handles their own
   *  outer auth (Privy, an internal cookie, etc.). */
  fetchChatToken: FetchChatToken;
  /** Optional. Defaults to WebKVStore (IndexedDB) in browsers. Tests pass
   *  MemoryKVStore to avoid the IDB dependency. */
  store?: KVStore;
  /** Optional. Defaults to OlmCryptoAdapter wrapping vodozemac. Tests
   *  pass FakeCryptoAdapter to avoid bundling WASM in the test runner. */
  crypto?: CryptoAdapter;
  /** Optional fetch implementation. Defaults to globalThis.fetch. Tests
   *  pass a mocked fetch to avoid real network calls. */
  fetchImpl?: typeof fetch;
}

// ── public event types ──────────────────────────────────────────────────────

export interface MessageReceived {
  peerUserId: string;
  peerDeviceId: string;
  /** The user that authored this message. Equals selfUserId when the
   *  message arrived via self-echo from another own device. */
  senderUserId: string;
  message: { id: string; text: string; replyTo?: string; sentAt: number };
}

export interface MessageEdited {
  peerUserId: string;
  /** Author of the edit. Equals selfUserId for self-echoed edits. */
  editorUserId: string;
  targetId: string;
  newText: string;
  editedAt: number;
}

export interface MessageDeleted {
  peerUserId: string;
  /** Author of the delete. Equals selfUserId for self-echoed deletes. */
  deleterUserId: string;
  targetId: string;
  deletedAt: number;
}

export interface ReadReceiptEvent {
  peerUserId: string;
  peerDeviceId: string;
  upToId: string;
}

export interface TypingEvt {
  peerUserId: string;
  peerDeviceId: string;
  state: "started" | "stopped";
}

export interface StatusChangeEvt {
  peerUserId: string;
  messageId: string;
  status: MessageStatus;
}

/**
 * Emitted the first time the SDK observes a previously-unknown peer device,
 * either via an inbound prekey-message from it OR via a refreshed device
 * list. Apps render this as the "Bob is using a new device — verify?"
 * banner per plan §17.
 */
export interface PeerNewDeviceEvt {
  peerUserId: string;
  peerDeviceId: string;
  fingerprint: string;
}

interface EventMap {
  message: MessageReceived;
  messageEdited: MessageEdited;
  messageDeleted: MessageDeleted;
  readReceipt: ReadReceiptEvent;
  typing: TypingEvt;
  statusChange: StatusChangeEvt;
  peerNewDevice: PeerNewDeviceEvt;
}

type EventName = keyof EventMap;
type Listener<T extends EventName> = (event: EventMap[T]) => void;

// ── DTelecomSecureChat ──────────────────────────────────────────────────────

const RECEIVED_BATCH_FLUSH_MS = 500;
const RECEIVED_BATCH_FLUSH_SIZE = 50;
const READ_RECEIPTS_KEY = "prefs/readReceiptsEnabled";

/** Public shape returned by `getKnownPeerDevices()`. */
export interface KnownPeerDevice {
  deviceId: string;
  fingerprint: string;
  lastActiveAt: number;
  /** True if the local user has explicitly verified this device. */
  verified: boolean;
}

function verifiedKey(peerUserId: string, peerDeviceId: string): string {
  return `verifiedDevice/${peerUserId}/${peerDeviceId}`;
}

export class DTelecomSecureChat {
  private deviceId!: string;
  private http!: HttpClient;
  private ws!: WsClient;
  private crypto!: CryptoAdapter;
  private store!: KVStore;
  private keyBundle!: KeyBundleManager;
  private sessions!: SessionManager;
  private peerDevices!: PeerDeviceCache;
  private messages!: MessageStore;
  private status!: StatusTracker;
  private outbox = new Outbox();
  private typingMgr!: TypingManager;
  private listeners = new Map<EventName, Set<(event: unknown) => void>>();

  /** Per-peer-device queue of received-event ids awaiting batch send. */
  private pendingReceived = new Map<string, string[]>();
  private receivedFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Self user id derived from chat-token claims after first mint. */
  private selfUserId: string | null = null;
  /** Devices we've already emitted `peerNewDevice` for, to avoid duplicates. */
  private announcedNewDevices = new Set<string>();
  /** True after we've reuploaded the bundle once for this connection — set
   *  after a "peer has zero devices" outcome that suggests the backend
   *  forgot us (registry mismatch / wipe). Don't loop. */
  private bundleReuploadAttempted = false;
  /** Cache of the read-receipts preference (loaded lazily). */
  private readReceiptsCache: boolean | null = null;

  /**
   * Connect to the dtelecom mesh. Generates an Olm account on first run,
   * uploads the bundle, opens /chat/ws to the closest discovered node,
   * and pulls any pending offline envelopes.
   */
  static async connect(opts: ConnectOptions): Promise<DTelecomSecureChat> {
    const chat = new DTelecomSecureChat();
    await chat.bootstrap(opts);
    return chat;
  }

  // The constructor is private-by-convention — use connect().
  private constructor() {}

  /** Stable per-install device id. Useful for app diagnostics. */
  get currentDeviceId(): string {
    return this.deviceId;
  }

  // ── public API: messaging ──────────────────────────────────────────────────

  async sendText(peerUserId: string, text: string, opts?: { replyTo?: string }): Promise<string> {
    const event = newText(text, opts?.replyTo);
    await this.sendContent(peerUserId, event, { ephemeral: false });

    // Persist locally so the UI can show our own sent message.
    if (this.selfUserId) {
      await this.messages.put({
        id: event.id,
        peerUserId,
        senderUserId: this.selfUserId,
        text: event.text,
        sentAt: event.clientSentAt,
        editedAt: null,
        deletedAt: null,
        ...(event.replyTo !== undefined ? { replyTo: event.replyTo } : {}),
      });
    }
    await this.selfEcho(peerUserId, event);
    this.typingMgr.clearOnSend(peerUserId);
    return event.id;
  }

  async editMessage(peerUserId: string, targetId: string, newText: string): Promise<string> {
    const event = newEdit(targetId, newText);
    await this.sendContent(peerUserId, event, { ephemeral: false });
    if (this.selfUserId) {
      await this.messages.applyEdit({
        targetId,
        editorUserId: this.selfUserId,
        newText,
        editedAt: event.clientSentAt,
      });
    }
    await this.selfEcho(peerUserId, event);
    return event.id;
  }

  async deleteMessage(peerUserId: string, targetId: string): Promise<string> {
    const event = newDelete(targetId);
    await this.sendContent(peerUserId, event, { ephemeral: false });
    if (this.selfUserId) {
      await this.messages.applyDelete({
        targetId,
        deleterUserId: this.selfUserId,
        deletedAt: event.clientSentAt,
      });
    }
    await this.selfEcho(peerUserId, event);
    return event.id;
  }

  /**
   * Send a read-watermark to `peerUserId`. No-op when read receipts are
   * disabled by `setReadReceiptsEnabled(false)` — the local user remains
   * invisible to senders, but inbound `read` events from peers are still
   * consumed (the sender's preference is their own call).
   */
  async markRead(peerUserId: string, upToMessageId: string): Promise<void> {
    if (!(await this.areReadReceiptsEnabled())) return;
    const event = newRead(upToMessageId);
    await this.sendContent(peerUserId, event, { ephemeral: false });
    await this.selfEcho(peerUserId, event);
  }

  setTyping(peerUserId: string, isTyping: boolean): void {
    this.typingMgr.setTyping(peerUserId, isTyping);
  }

  // ── public API: preferences ───────────────────────────────────────────────

  /** Enable/disable outbound read receipts. Persisted in the local KV store. */
  async setReadReceiptsEnabled(enabled: boolean): Promise<void> {
    await this.store.setString(READ_RECEIPTS_KEY, enabled ? "1" : "0");
    this.readReceiptsCache = enabled;
  }

  /** Read the current preference. Default true. */
  async areReadReceiptsEnabled(): Promise<boolean> {
    if (this.readReceiptsCache !== null) return this.readReceiptsCache;
    const raw = await this.store.getString(READ_RECEIPTS_KEY);
    const enabled = raw === null ? true : raw === "1";
    this.readReceiptsCache = enabled;
    return enabled;
  }

  // ── public API: peer device verification ──────────────────────────────────

  /**
   * Returns the cached peer-device list for `peerUserId`. Refreshes via
   * `list_devices` if the local cache is empty or stale. Used to render
   * the "Known Devices" settings panel. Doesn't consume OTKs.
   */
  async getKnownPeerDevices(peerUserId: string): Promise<KnownPeerDevice[]> {
    const devices = await this.peerDevices.getPeerDevices(peerUserId);
    const out: KnownPeerDevice[] = [];
    for (const d of devices) {
      const verified = await this.isPeerDeviceVerified(peerUserId, d.deviceId);
      out.push({
        deviceId: d.deviceId,
        fingerprint: d.fingerprint,
        lastActiveAt: d.lastActiveAt,
        verified,
      });
    }
    return out;
  }

  /** Single-device fingerprint accessor. Returns null if unknown. */
  async getPeerDeviceFingerprint(
    peerUserId: string,
    peerDeviceId: string,
  ): Promise<string | null> {
    const list = await this.peerDevices.getPeerDevices(peerUserId);
    return list.find((d) => d.deviceId === peerDeviceId)?.fingerprint ?? null;
  }

  /**
   * Mark a peer device as verified (or unverified). Local-only — doesn't
   * change the protocol's behavior, just exposes a flag the UI can render.
   */
  async markPeerDeviceVerified(
    peerUserId: string,
    peerDeviceId: string,
    verified: boolean,
  ): Promise<void> {
    const key = verifiedKey(peerUserId, peerDeviceId);
    if (verified) {
      await this.store.setString(key, "1");
    } else {
      await this.store.delete(key);
    }
  }

  async isPeerDeviceVerified(peerUserId: string, peerDeviceId: string): Promise<boolean> {
    return (await this.store.getString(verifiedKey(peerUserId, peerDeviceId))) === "1";
  }

  /**
   * Read persisted message history with `peerUserId`, oldest→newest within
   * the page. Use `beforeSentAt` + `limit` to paginate older messages.
   * Returns include local-sent messages (sender = self), inbound messages
   * (sender = peer), and tombstoned/edited rows reflecting the latest state.
   */
  getHistory(
    peerUserId: string,
    opts: { limit?: number; beforeSentAt?: number } = {},
  ): Promise<StoredMessage[]> {
    return this.messages.listForPeer(peerUserId, opts);
  }

  // ── public API: blocks ─────────────────────────────────────────────────────

  blockUser(peerUserId: string): Promise<{ ok: true }> {
    return this.http.blockUser(this.deviceId, peerUserId);
  }
  unblockUser(peerUserId: string): Promise<{ ok: true }> {
    return this.http.unblockUser(this.deviceId, peerUserId);
  }
  async getBlockedUsers(): Promise<string[]> {
    const r = await this.http.listBlocked(this.deviceId);
    return r.blocked;
  }

  // ── public API: events ─────────────────────────────────────────────────────

  on<T extends EventName>(event: T, fn: Listener<T>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as (event: unknown) => void);
    return () => set!.delete(fn as (event: unknown) => void);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    this.typingMgr.shutdown();
    this.flushReceivedBatch();
    await this.ws.close();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async bootstrap(opts: ConnectOptions): Promise<void> {
    this.store = opts.store ?? new WebKVStore();
    this.crypto = opts.crypto ?? new OlmCryptoAdapter({ store: this.store });
    await this.crypto.init();

    this.deviceId = await loadOrCreateDeviceId(this.store);

    this.http = new HttpClient({
      apiBaseURL: opts.apiBaseURL,
      fetchChatToken: opts.fetchChatToken,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });

    // Seed the token cache and capture our self user id from the claims.
    const mint = await this.http.getMint(this.deviceId);
    this.selfUserId = parseSubFromJwt(mint.chatToken);

    this.keyBundle = new KeyBundleManager({ http: this.http, crypto: this.crypto, deviceId: this.deviceId });
    await this.keyBundle.ensureKeyBundle();

    this.sessions = new SessionManager({
      http: this.http,
      crypto: this.crypto,
      selfDeviceId: this.deviceId,
      selfUserId: this.selfUserId,
    });
    this.peerDevices = new PeerDeviceCache({ http: this.http, selfDeviceId: this.deviceId });
    this.messages = new MessageStore(this.store);
    this.status = new StatusTracker();
    this.status.on((messageId, status, peerUserId) => {
      this.dispatch("statusChange", { peerUserId, messageId, status });
    });

    this.typingMgr = new TypingManager((peerUserId, state) => {
      // Fire-and-forget; we don't await typing ephemeral fanout.
      this.sendContent(peerUserId, newTyping(state), { ephemeral: true }).catch(() => {});
    });

    // Connect WS to the discovered node URL. Strip a trailing /chat/ws
    // path if the discovery returned one — WsClient appends it.
    const nodeUrl = mint.chatNodeWsUrl.replace(/\/chat\/ws\/?$/, "");
    this.ws = new WsClient({
      nodeBaseURL: nodeUrl,
      getToken: () => this.http.getToken(this.deviceId),
      onFrame: (f) => this.onFrame(f),
      onState: (s) => this.onWsState(s),
    });
    await this.ws.connect();

    // Drain any offline envelopes that landed while we were away.
    await this.drainPending();

    // Refill OTKs if the server-side count has dropped below the
    // watermark. Best-effort — failure here doesn't block bootstrap.
    void this.keyBundle.topUpIfNeeded().catch(() => {});

    // Pre-populate the session bundle cache for our OWN user so the
    // first self-echo from this device fanouts to all currently-
    // registered own devices. Without this, the first send-after-
    // boot would self-echo to nobody (cache miss → claim_all on
    // demand only happens at first send to selfUserId, which is
    // also the moment we'd need it).
    if (this.selfUserId) {
      void this.sessions.refreshPeerBundles(this.selfUserId).catch(() => {});
    }
  }

  /**
   * State-listener for the underlying WsClient. On every transition to
   * "open" (initial connect AND auto-reconnect), drain any queued
   * outbound sends and re-pull pending offline envelopes — closes the
   * gap during disconnect.
   */
  private onWsState(s: string): void {
    if (s !== "open") return;
    void this.outbox.tick();
    void this.drainPending().catch(() => {});
    // Reconnect-time topup catches the case where the device sat
    // offline long enough for many incoming sessions to deplete OTKs.
    void this.keyBundle.topUpIfNeeded().catch(() => {});
  }

  /** Set true while drainPending is running to avoid overlapping calls
   *  (would otherwise hand the same envelope to two concurrent decrypt
   *  invocations — Olm rejects the second). */
  private drainingPending = false;

  private async drainPending(): Promise<void> {
    if (this.drainingPending) return;
    this.drainingPending = true;
    try {
      while (true) {
        const r = await this.http.pending(this.deviceId, 100);
        if (r.envelopes.length === 0) return;
        const ackUuids: string[] = [];
        for (const env of r.envelopes) {
          try {
            await this.handleInboundCiphertext({
              peerUserId: env.senderUserId,
              peerDeviceId: env.senderDeviceId,
              ciphertext: env.ciphertext,
              msgType: env.msgType,
            });
            ackUuids.push(env.envelopeUuid);
          } catch {
            // decrypt failed — leave on the queue for now.
          }
        }
        if (ackUuids.length === 0) return;
        await this.http.ack(this.deviceId, ackUuids);
      }
    } finally {
      this.drainingPending = false;
    }
  }

  private async onFrame(frame: InboundFrame): Promise<void> {
    if (frame.kind === "chatEnvelope") {
      await this.handleInboundCiphertext({
        peerUserId: frame.senderUserId,
        peerDeviceId: frame.senderDeviceId,
        ciphertext: frame.ciphertext,
        msgType: frame.msgType,
      });
      return;
    }
    if (frame.kind === "chatSendResult") {
      for (const r of frame.results) {
        this.status.onSendResult(r.envelopeUuid, r.status);
      }
      return;
    }
    // chat_pong — ignore; ws.ts already handles ping liveness.
  }

  private async handleInboundCiphertext(opts: {
    peerUserId: string;
    peerDeviceId: string;
    ciphertext: string;
    msgType: "prekey" | "normal";
  }): Promise<void> {
    let plaintext: string;
    try {
      plaintext = await this.sessions.decrypt(
        opts.peerUserId,
        opts.peerDeviceId,
        opts.ciphertext,
        opts.msgType,
      );
    } catch (firstErr) {
      // On-decrypt-failure recovery: drop the broken session, refresh the
      // peer's device list (peer may have a new device whose fingerprint
      // doesn't match our cache), retry decrypt once. For msgType=prekey
      // the retry can succeed by bootstrapping a fresh inbound session;
      // for msgType=normal a forgotten session can't recover this message,
      // but the next inbound from peer arrives as prekey-type and rebuilds.
      await this.sessions.forgetPeerDevice(opts.peerUserId, opts.peerDeviceId);
      this.peerDevices.invalidate(opts.peerUserId);
      try {
        await this.peerDevices.refresh(opts.peerUserId);
      } catch {
        // refresh is best-effort; carry on with retry regardless
      }
      try {
        plaintext = await this.sessions.decrypt(
          opts.peerUserId,
          opts.peerDeviceId,
          opts.ciphertext,
          opts.msgType,
        );
      } catch {
        // Still broken — drop. Future messages from peer will re-bootstrap.
        throw firstErr;
      }
    }
    // Plan §17 prekey-discovery: if this peer device wasn't known to the
    // local cache before, refresh + emit peerNewDevice. Done after a
    // successful decrypt so we only learn about devices that produced
    // valid messages (not random spammers attempting random sessions).
    await this.maybeAnnouncePeerDevice(opts.peerUserId, opts.peerDeviceId);

    const event = decodeEventBytes(new TextEncoder().encode(plaintext));
    if (!event) return; // unknown / malformed: drop silently
    await this.dispatchInboundEvent(opts.peerUserId, opts.peerDeviceId, event);
  }

  /**
   * If `peerDeviceId` is not in our local cache for `peerUserId`, refresh
   * the peer's device list and emit `peerNewDevice` exactly once. Idempotent
   * across repeated calls — second message from the same new device is a
   * cheap cache hit. Failures (HTTP error fetching the device list) are
   * swallowed; we'll re-attempt on the next inbound from this device.
   */
  private async maybeAnnouncePeerDevice(peerUserId: string, peerDeviceId: string): Promise<void> {
    const flag = `${peerUserId}|${peerDeviceId}`;
    if (this.announcedNewDevices.has(flag)) return;

    let devices: Awaited<ReturnType<PeerDeviceCache["getPeerDevices"]>>;
    try {
      devices = await this.peerDevices.getPeerDevices(peerUserId);
    } catch {
      return;
    }
    let entry = devices.find((d) => d.deviceId === peerDeviceId);
    if (!entry) {
      // Stale cache — peer added a device since the last refresh. Force one.
      let fresh: typeof devices;
      try {
        fresh = await this.peerDevices.refresh(peerUserId);
      } catch {
        return;
      }
      entry = fresh.find((d) => d.deviceId === peerDeviceId);
      if (!entry) return; // device truly unknown to backend; defensive
    }

    this.announcedNewDevices.add(flag);
    // The peerDevices cache now knows about the new device, but the
    // session-level bundleCache (used by encryptForPeer) was populated
    // before this device existed. Refresh it so the next outbound send
    // fanouts to the new device too. Best-effort — failures here are
    // swallowed and the user can recover by triggering a re-claim
    // through normal traffic.
    try {
      await this.sessions.refreshPeerBundles(peerUserId);
    } catch {
      // ignore
    }
    this.dispatch("peerNewDevice", {
      peerUserId,
      peerDeviceId,
      fingerprint: entry.fingerprint,
    });
  }

  private async dispatchInboundEvent(
    peerUserId: string,
    peerDeviceId: string,
    event: ContentEvent,
  ): Promise<void> {
    switch (event.type) {
      case "text": {
        await this.messages.put({
          id: event.id,
          peerUserId,
          senderUserId: peerUserId,
          text: event.text,
          sentAt: event.clientSentAt,
          editedAt: null,
          deletedAt: null,
          ...(event.replyTo !== undefined ? { replyTo: event.replyTo } : {}),
        });
        this.dispatch("message", {
          peerUserId,
          peerDeviceId,
          senderUserId: peerUserId,
          message: {
            id: event.id,
            text: event.text,
            sentAt: event.clientSentAt,
            ...(event.replyTo !== undefined ? { replyTo: event.replyTo } : {}),
          },
        });
        this.queueReceivedAck(peerUserId, peerDeviceId, event.id);
        return;
      }
      case "edit": {
        const updated = await this.messages.applyEdit({
          targetId: event.targetId,
          editorUserId: peerUserId,
          newText: event.text,
          editedAt: event.clientSentAt,
        });
        if (updated) {
          this.dispatch("messageEdited", {
            peerUserId,
            editorUserId: peerUserId,
            targetId: event.targetId,
            newText: event.text,
            editedAt: event.clientSentAt,
          });
        }
        this.queueReceivedAck(peerUserId, peerDeviceId, event.id);
        return;
      }
      case "delete": {
        const updated = await this.messages.applyDelete({
          targetId: event.targetId,
          deleterUserId: peerUserId,
          deletedAt: event.clientSentAt,
        });
        if (updated) {
          this.dispatch("messageDeleted", {
            peerUserId,
            deleterUserId: peerUserId,
            targetId: event.targetId,
            deletedAt: event.clientSentAt,
          });
        }
        this.queueReceivedAck(peerUserId, peerDeviceId, event.id);
        return;
      }
      case "read": {
        this.status.onRead({ peerUserId, upToId: event.upToId });
        this.dispatch("readReceipt", { peerUserId, peerDeviceId, upToId: event.upToId });
        return;
      }
      case "received": {
        this.status.onReceived({ peerUserId, peerDeviceId, messageIds: event.ids });
        return;
      }
      case "typing": {
        this.dispatch("typing", { peerUserId, peerDeviceId, state: event.state });
        return;
      }
      case "selfEcho": {
        // Multi-device self-echo. The Olm session binding guarantees the
        // outer ciphertext came from a session keyed under our own user;
        // sender authenticity is therefore cryptographic. Defensive check:
        // the wire layer routes by peerUserId, so an untrusted sender
        // can't fake peerUserId === selfUserId without first establishing
        // an Olm session under our user — which they can't do.
        if (peerUserId !== this.selfUserId) return;
        const inner = event.original;
        const originalPeer = event.originalPeer;
        switch (inner.type) {
          case "text": {
            await this.messages.put({
              id: inner.id,
              peerUserId: originalPeer,
              senderUserId: peerUserId,
              text: inner.text,
              sentAt: inner.clientSentAt,
              editedAt: null,
              deletedAt: null,
              ...(inner.replyTo !== undefined ? { replyTo: inner.replyTo } : {}),
            });
            this.dispatch("message", {
              peerUserId: originalPeer,
              peerDeviceId,
              senderUserId: peerUserId,
              message: {
                id: inner.id,
                text: inner.text,
                sentAt: inner.clientSentAt,
                ...(inner.replyTo !== undefined ? { replyTo: inner.replyTo } : {}),
              },
            });
            return;
          }
          case "edit": {
            const updated = await this.messages.applyEdit({
              targetId: inner.targetId,
              editorUserId: peerUserId,
              newText: inner.text,
              editedAt: inner.clientSentAt,
            });
            if (updated) {
              this.dispatch("messageEdited", {
                peerUserId: originalPeer,
                editorUserId: peerUserId,
                targetId: inner.targetId,
                newText: inner.text,
                editedAt: inner.clientSentAt,
              });
            }
            return;
          }
          case "delete": {
            const updated = await this.messages.applyDelete({
              targetId: inner.targetId,
              deleterUserId: peerUserId,
              deletedAt: inner.clientSentAt,
            });
            if (updated) {
              this.dispatch("messageDeleted", {
                peerUserId: originalPeer,
                deleterUserId: peerUserId,
                targetId: inner.targetId,
                deletedAt: inner.clientSentAt,
              });
            }
            return;
          }
          case "read": {
            // Mirror the read watermark so this device's chat ratchets
            // statuses forward the same way the originating device did.
            this.status.onRead({ peerUserId: originalPeer, upToId: inner.upToId });
            return;
          }
        }
        return;
      }
    }
  }

  /**
   * Multi-device self-echo. Wraps the original event in a `selfEcho`
   * envelope and ships it to our own user (mesh fanout filters our
   * own device). Other devices belonging to the same user receive,
   * unwrap, and persist the event so their local history mirrors this
   * device's. No-op when:
   *   - we don't yet know our own user id
   *   - the original was addressed to ourselves (avoids loops)
   *   - we have no other devices registered (encryptForPeer returns [])
   * Best-effort: failures here don't surface to the caller.
   */
  private async selfEcho(originalPeer: string, original: SelfEchoableEvent): Promise<void> {
    if (!this.selfUserId) return;
    if (originalPeer === this.selfUserId) return;
    const echo = newSelfEcho(originalPeer, original);
    try {
      // If the cached self-fanout would be empty (first send after
      // boot, or a sibling device just registered), force a refresh
      // before encrypting. In steady state the cache hits the size>0
      // branch and we skip the refresh.
      const cached = this.sessions.cachedFanoutSize(this.selfUserId);
      if (cached === null || cached === 0) {
        try {
          await this.sessions.refreshPeerBundles(this.selfUserId);
        } catch {
          return;
        }
      }
      await this.sendContent(this.selfUserId, echo, { ephemeral: false });
    } catch {
      // ignore — peer-side delivery already succeeded; sync convergence
      // gets a second chance on the next send.
    }
  }

  private async sendContent(
    peerUserId: string,
    event: ContentEvent,
    opts: { ephemeral: boolean },
  ): Promise<void> {
    const plainBytes = encodeEventBytes(event);
    const plaintext = new TextDecoder().decode(plainBytes);
    const encrypted = await this.sessions.encryptForPeer(peerUserId, plaintext);
    if (encrypted.length === 0) {
      // Peer has no devices (or has blocked us). Same shape as Signal's
      // "this user can't be reached." If we have message history with
      // this peer, suspect a registry mismatch / backend wipe and trigger
      // a one-shot self-bundle reupload so future sends might recover.
      // Don't loop — bundleReuploadAttempted ensures one attempt per
      // SDK session, and we don't retry the failed encrypt.
      if (!opts.ephemeral && !this.bundleReuploadAttempted) {
        const seenBefore =
          (await this.messages.listForPeer(peerUserId, { limit: 1 })).length > 0;
        if (seenBefore) {
          this.bundleReuploadAttempted = true;
          try {
            await this.keyBundle.reuploadCurrentBundle();
          } catch {
            // best-effort — we'll see future failures via the same path
          }
        }
      }
      return;
    }
    const targets: ChatSendTarget[] = encrypted.map((e) => ({
      deviceId: e.peerDeviceId,
      ciphertext: e.ciphertext,
      envelopeUuid: globalThis.crypto.randomUUID(),
    }));

    // For non-typing/non-read events, register with the status tracker
    // so chatSendResult and inbound `received`/`read` can update status.
    if (event.type === "text" || event.type === "edit" || event.type === "delete") {
      const map = new Map<string, string>();
      for (const t of targets) map.set(t.envelopeUuid, t.deviceId);
      this.status.trackOutbound({ messageId: event.id, peerUserId, envelopeToDevice: map });
    }

    const msgType = encrypted[0].msgType; // shared across targets in this fanout
    const frame = {
      toUserId: peerUserId,
      ephemeral: opts.ephemeral || undefined,
      msgType,
      targets,
    } as const;

    if (opts.ephemeral) {
      // Typing & other ephemerals are fire-and-forget — if the WS isn't
      // open, drop silently. Retrying typing later would deliver a
      // confusing "X is typing" hours after the fact.
      if (this.ws.getState() === "open") {
        try {
          this.ws.sendChat(frame);
        } catch {
          // ignore
        }
      }
      return;
    }

    // Persistent events (text/edit/delete/read/received) go through the
    // outbox — if the WS is closed at send time, the entry queues and
    // drains on the next "open" transition. Idempotent on messageId; the
    // outbox keys by it.
    this.outbox.enqueue({
      messageId: event.id,
      peerUserId,
      ephemeral: false,
      attempt: async () => {
        const outcomes = new Map<string, "live" | "stored" | "dropped" | "error">();
        if (this.ws.getState() !== "open") {
          for (const t of targets) outcomes.set(t.envelopeUuid, "error");
          return outcomes;
        }
        try {
          this.ws.sendChat(frame);
          // Synthesize "stored" so the outbox treats this as a successful
          // attempt and removes the entry. The real per-target outcome
          // arrives separately as a chatSendResult frame (consumed by
          // StatusTracker). Outbox only cares "did the send go out at all".
          for (const t of targets) outcomes.set(t.envelopeUuid, "stored");
        } catch {
          for (const t of targets) outcomes.set(t.envelopeUuid, "error");
        }
        return outcomes;
      },
    });
    // Best-effort immediate attempt; if the WS is open we'll send right now,
    // otherwise the entry waits for the next "open" transition.
    void this.outbox.tick();

    void this.peerDevices; // reserved for on-decrypt-failure refresh path
  }

  private queueReceivedAck(peerUserId: string, peerDeviceId: string, eventId: string): void {
    const key = `${peerUserId}|${peerDeviceId}`;
    const list = this.pendingReceived.get(key) ?? [];
    list.push(eventId);
    this.pendingReceived.set(key, list);
    if (list.length >= RECEIVED_BATCH_FLUSH_SIZE) {
      this.flushReceivedBatch();
      return;
    }
    if (!this.receivedFlushTimer) {
      this.receivedFlushTimer = setTimeout(() => this.flushReceivedBatch(), RECEIVED_BATCH_FLUSH_MS);
    }
  }

  private flushReceivedBatch(): void {
    if (this.receivedFlushTimer) {
      clearTimeout(this.receivedFlushTimer);
      this.receivedFlushTimer = null;
    }
    if (this.pendingReceived.size === 0) return;
    for (const [key, ids] of this.pendingReceived.entries()) {
      const [peerUserId] = key.split("|");
      this.sendContent(peerUserId, newReceived(ids), { ephemeral: false }).catch(() => {});
    }
    this.pendingReceived.clear();
  }

  private dispatch<T extends EventName>(name: T, event: EventMap[T]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as Listener<T>)(event);
      } catch {
        // listener errors must not break the SDK
      }
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function parseSubFromJwt(jwt: string): string | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const padLen = (4 - (parts[1].length % 4)) % 4;
    const padded = parts[1] + "=".repeat(padLen);
    const std = padded.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(std);
    const claims = JSON.parse(decoded) as { sub?: string };
    return claims.sub ?? null;
  } catch {
    return null;
  }
}

// ── re-exports for advanced consumers ───────────────────────────────────────

export type { CryptoAdapter } from "./crypto/interface.js";
export { OlmCryptoAdapter } from "./crypto/olm-adapter.js";
export { FakeCryptoAdapter } from "./crypto/fake-adapter.js";
export { MemoryKVStore } from "./store/memory-adapter.js";
export { WebKVStore } from "./store/web-adapter.js";
export type { KVStore } from "./store/interface.js";
export type { StoredMessage };
export type { MessageStatus } from "./status.js";
