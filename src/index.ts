// Public SDK surface. Wires transport + crypto + content protocol behind
// a small event-emitter API. Most app code will only ever touch this file.

import { CONTENT_PROTOCOL_VERSION as _CONTENT_VERSION, EDIT_WINDOW_MS } from "./content/protocol.js";
import {
  decodeEventBytes,
  encodeEventBytes,
  newChatDeleteAll,
  newChatDeleteSelf,
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
export { EDIT_WINDOW_MS } from "./content/protocol.js";
import type { CryptoAdapter } from "./crypto/interface.js";
import { OlmCryptoAdapter } from "./crypto/olm-adapter.js";
import { generateUUID, loadOrCreateDeviceId } from "./device.js";
import { PeerDeviceCache } from "./device_discovery.js";
import { KeyBundleManager } from "./key_bundle.js";
import { MessageStore, type StoredMessage } from "./message_store.js";
import { ConversationIndex } from "./conversations.js";
export type { Conversation } from "./conversations.js";
import type { Conversation } from "./conversations.js";
import { EnvelopeDedup } from "./envelope_dedup.js";
import { LogContext, type LogEvent, type Logger, type LogLevel } from "./logging.js";
export type { LogLevel, LogEvent } from "./logging.js";
import { Outbox } from "./outbox.js";
import { SessionManager } from "./sessions.js";
import { StatusTracker, type MessageStatus } from "./status.js";
import type { KVStore } from "./store/interface.js";
import { migrateLegacyKeys, ScopedKVStore, wipeScope } from "./store/scoped-adapter.js";
import { WebKVStore } from "./store/web-adapter.js";
import { HttpClient, type FetchChatToken, type FetchHttpBearer } from "./transport/http.js";
export type { FetchChatToken, FetchHttpBearer } from "./transport/http.js";
import { WsClient } from "./transport/ws.js";
import { TypingManager } from "./typing.js";
import type { ChatSendResult, ChatSendTarget, InboundFrame } from "./types.js";

export const VERSION = "0.0.0";
export const CONTENT_PROTOCOL_VERSION = _CONTENT_VERSION;

// ── public option types ─────────────────────────────────────────────────────

export interface ConnectOptions {
  /** dmeet-backend (or mock) base URL — e.g. https://dmeet.example.com */
  apiBaseURL: string;
  /** Authenticated user id (Privy `did:privy:...` in production, opaque
   *  string in tests). Required — used to namespace ALL persisted SDK
   *  state under `u/<userId>/...` so multiple users on the same physical
   *  device / KV instance see disjoint storage. The SDK verifies this
   *  matches the chat token's `sub` claim on first mint and throws if
   *  not, defending against caller-side misconfiguration. */
  selfUserId: string;
  /** Function that mints a chat token + returns the closest dtelecom node WS
   *  URL. The token is used ONLY on the WebSocket handshake (the dtelecom
   *  node can't verify Privy tokens — it needs the Solana-registry-signed
   *  JWT). The HTTP API uses a separate bearer — see `fetchHttpBearer`. */
  fetchChatToken: FetchChatToken;
  /** Function returning the bearer the SDK attaches to every HTTP request
   *  to the tenant backend (`/keys/*`, `/envelopes/*`). For dmeet this is
   *  the Privy access token — exactly what every other `/api/*` route
   *  expects. For the in-memory mock this can be the chat JWT (the mock
   *  accepts that). Called once per HTTP request — let the host's session
   *  library handle caching/refresh. */
  fetchHttpBearer: FetchHttpBearer;
  /** Optional. Defaults to WebKVStore (IndexedDB) in browsers. Tests pass
   *  MemoryKVStore to avoid the IDB dependency. */
  store?: KVStore;
  /** Optional. Defaults to OlmCryptoAdapter wrapping vodozemac. Tests
   *  pass FakeCryptoAdapter to avoid bundling WASM in the test runner. */
  crypto?: CryptoAdapter;
  /** Optional fetch implementation. Defaults to globalThis.fetch. Tests
   *  pass a mocked fetch to avoid real network calls. */
  fetchImpl?: typeof fetch;
  /** Optional initial block list. Block enforcement lives mostly outside
   *  the SDK (host backends like dmeet write their own user-block table,
   *  which the chat backend reads server-side). But existing Olm sessions
   *  with a now-blocked peer are NOT torn down, so inbound messages from
   *  that peer can still arrive over the WS — the SDK drops them locally
   *  per `chat-wire-contract.md` §14 / `secure-chat-plan.md` §14.
   *
   *  Pass the host's current block list here on connect; call
   *  `chat.setBlockedUserIds` whenever it changes. The SDK also persists
   *  the last-known list in KV, so a cold start during offline-pending
   *  drain doesn't surface blocked messages before the host has refreshed
   *  its view. */
  initialBlockedUserIds?: string[];
  /** Minimum time (ms) between background-discovery calls for the same
   *  peer. Each outbound `sendText` for a non-self peer kicks off a
   *  cheap `/keys/list_devices` to detect newly-registered devices; this
   *  floor coalesces a chatty burst into a single discovery per window.
   *  Default 30_000. Set lower (e.g. 0) in tests that want every send
   *  to be able to discover. */
  backgroundDiscoveryFloorMs?: number;
  /** When `false`, disables the per-send background-discovery path
   *  entirely. The bundleCache is only refreshed on reconnect or via
   *  explicit `refreshPeerBundles` (caller-driven). Default `true`. */
  backgroundDiscovery?: boolean;
  /**
   * Console log level for SDK internals. Off by default (`"silent"`).
   *
   * Levels (each level includes everything above):
   *  - `"silent"` — no console output (default)
   *  - `"error"`  — only failures
   *  - `"warn"`   — failures + suspicious states
   *  - `"info"`   — major lifecycle events (WS open/close, cache transitions)
   *  - `"debug"`  — every HTTP call, every decrypt, every dedup hit
   *
   * Without this opt-in, you can also enable from the browser console:
   *   `localStorage.setItem("@dtelecom/secure-chat-client:debug", "debug")`
   * then reload. Useful for diagnosing a deployed app without redeploy.
   *
   * Independent of console output, the SDK ALWAYS keeps the last ~256
   * events in an in-memory ring buffer accessible via
   * {@link DTelecomSecureChat.getDiagnostics}. Bug reports can capture
   * that snapshot without devtools access.
   */
  debug?: LogLevel;
}

/**
 * Snapshot of internal SDK state for debugging. Returned by
 * {@link DTelecomSecureChat.getDiagnostics}. Safe to dump into a bug
 * report — no ciphertext, no private keys, no plaintext message content.
 */
export interface ChatDiagnostics {
  /** Resolved log level (after ConnectOptions / localStorage merge). */
  logLevel: LogLevel;
  /** This SDK instance's user + device. */
  selfUserId: string | null;
  deviceId: string;
  /** True iff this tab owns the WebSocket lock (false on secondary tabs). */
  isPrimary: boolean;
  /** Underlying WebSocket state. */
  wsState: ConnectionState;
  /** Per-peer bundleCache state (no key material — just shape). */
  bundleCache: Array<{ peerUserId: string; deviceCount: number; emptyCooldownExpiresAt?: number }>;
  /** Per-peer device-list cache (fetched via list_devices). */
  peerDevicesCache: Array<{ peerUserId: string; deviceCount: number; fetchedAt: number }>;
  /** In-flight background ops, by peerUserId. */
  inflightClaimAll: string[];
  inflightDiscovery: string[];
  /** Total envelopeUuids in the persisted dedup set. */
  envelopeDedupSize: number;
  /** Most-recent log events (oldest first), bounded by the ring cap. */
  recentEvents: LogEvent[];
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

/**
 * Emitted whenever a conversation row's lastMessage* or lastReadFromPeerAt
 * changes (so unread counts and ordering are dirty). `changed` lists the
 * specific peerUserIds whose state moved; the UI can recompute selectively
 * or just reload the full list — both are cheap.
 */
export interface ConversationsChangedEvt {
  changed: string[];
  /** Sum of `unreadCount` across every conversation, including ones not in
   *  `changed`. Lets the chat tab badge update from a single listener
   *  without re-walking listConversations(). */
  totalUnread: number;
}

/**
 * Fired exactly once per outbound message when the SDK gives up. The
 * stored row's `status` is also written to `"failed"` so the UI can
 * render a "failed" indicator after reload. Apps can show a "retry"
 * button — the right way to retry is to call `chat.sendText(...)` with
 * the same text again; this creates a new `messageId` (the failed one
 * stays in history with `status: "failed"` and the user can delete it
 * locally).
 *
 * Reasons:
 *  - `"max_attempts_exceeded"`: the outbox exhausted its retry budget
 *    for this message (e.g., the WebSocket was never able to deliver
 *    the bytes to the node).
 *  - `"server_rejected"`: the node returned `chatSendResult.status =
 *    "error"` for every per-target envelope of this message. None of
 *    the recipient's devices received the send. *(added 0.13.3)*
 */
export interface MessageSendFailedEvt {
  peerUserId: string;
  messageId: string;
  reason: "max_attempts_exceeded" | "server_rejected";
}

/**
 * Emitted whenever this SDK instance changes its "primary tab" role.
 *
 * - `role: "secondary"` — another tab of the same `(origin, user)` is the
 *   active SDK instance. This tab's WebSocket is closed; local reads
 *   (`listConversations`, `getHistory`) still work, but outbound sends
 *   queue in the outbox and ultimately fail with `messageSendFailed`
 *   because the WS never opens. The frontend should render an "open
 *   elsewhere" overlay with a "Use here" button that calls
 *   `chat.takeOver()` to steal primary status.
 * - `role: "primary"` — this tab owns the WebSocket and the chat state.
 *   Render normal UX.
 *
 * The SDK arrives in `primary` automatically when no other tab holds the
 * lock; you only need a `tabConflict` listener if you support multi-tab
 * users (which any real app does). Fires:
 * - Once at boot if `connect()` discovers another tab is primary.
 * - When this tab gets stolen-from (another tab called `takeOver`).
 * - When this tab promotes (either via `takeOver` here, or because the
 *   previous primary disconnected and our background wait fired).
 *
 * On browsers without the Web Locks API, the SDK behaves as if always
 * primary — no `tabConflict` events fire and `takeOver` is a no-op.
 */
export interface TabConflictEvt {
  role: "primary" | "secondary";
  /** ms-epoch of this transition. Useful for "active since X" UI. */
  activeAt: number;
}

/**
 * Discriminated codes for `ChatError`. Always check `err.code` before
 * branching on user-facing copy.
 *
 * - `peer_unreachable` — `claim_all` returned no devices (peer has no
 *   chat-registered device, OR peer has blocked the caller server-side —
 *   the two cases are indistinguishable by design).
 * - `auth_expired` — backend returned 401/403. Prompt the user to re-login.
 *   `err.status` carries the actual code.
 * - `offline` — the underlying `fetch` threw (no network reachable).
 * - `rate_limited` — backend returned 429. `err.status === 429`.
 * - `server_error` — backend returned 5xx. `err.status` carries the code.
 * - `edit_window_expired` — `editMessage` called on a message older than
 *   `EDIT_WINDOW_MS` (default 24h). The original message is unchanged.
 * - `not_found` — the message id passed to `editMessage` / `deleteMessage`
 *   isn't in the local store. Usually a UI bug.
 * - `not_authorized` — caller tried to edit/delete a message they didn't
 *   author. The Olm-session-bound receiver check would also reject this,
 *   but the SDK catches it earlier so no wire send happens.
 * - `internal` — SDK-side bug, crypto failure, malformed state, etc.
 *   Usually means a code path needs investigation; safe to surface as a
 *   generic "Something went wrong" toast.
 */
export type ChatErrorCode =
  | "peer_unreachable"
  | "auth_expired"
  | "offline"
  | "rate_limited"
  | "server_error"
  | "edit_window_expired"
  | "not_found"
  | "not_authorized"
  | "internal";

/**
 * Typed error thrown by every public SDK method that touches the wire
 * (`sendText`, `editMessage`, `deleteMessage`, `markRead`, `retrySend`,
 * `getKnownPeerDevices`, etc.). Wraps lower-level HTTP / fetch / crypto
 * errors so the FE has a single type to switch on.
 */
export class ChatError extends Error {
  /** HTTP status code, when the error originated from an HTTP response. */
  status?: number;
  /** Original error for debugging — never displayed to the user. */
  cause?: Error;
  constructor(
    public code: ChatErrorCode,
    message: string,
    opts?: { status?: number; cause?: Error },
  ) {
    super(message);
    this.name = "ChatError";
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.cause) this.cause = opts.cause;
  }
}

/**
 * Map any thrown value into a `ChatError`. Used at the public-API boundary
 * so callers only ever see `ChatError`, never raw `HttpError` / `TypeError`
 * from `fetch` / Olm exceptions.
 */
function toChatError(err: unknown): ChatError {
  if (err instanceof ChatError) return err;
  // HttpError from transport/http.ts — detect by shape, since we don't
  // re-export the class.
  if (
    err instanceof Error &&
    err.name === "HttpError" &&
    typeof (err as { status?: unknown }).status === "number"
  ) {
    const status = (err as unknown as { status: number }).status;
    let code: ChatErrorCode;
    if (status === 401 || status === 403) code = "auth_expired";
    else if (status === 429) code = "rate_limited";
    else if (status >= 500) code = "server_error";
    else code = "internal";
    return new ChatError(code, err.message, { status, cause: err });
  }
  // fetch() rejects with TypeError when the network is unreachable.
  // Browsers + node-fetch behave the same way here.
  if (
    err instanceof TypeError &&
    /fetch|network|failed|abort/i.test(err.message)
  ) {
    return new ChatError("offline", err.message, { cause: err });
  }
  if (err instanceof Error) {
    return new ChatError("internal", err.message, { cause: err });
  }
  return new ChatError("internal", String(err));
}

/**
 * Detects vodozemac's "unknown one-time key" error message thrown by
 * `Account.createInboundSession` when the prekey-message references an
 * OTK that no longer exists in our local Account's pool.
 *
 * This is structurally terminal: no number of retries can resurrect a
 * private key that was consumed (one-time use, by design) or that was
 * lost (e.g., IndexedDB wiped on this device). The matching envelope
 * should be HTTP-acked to clear it from the backend's pending queue —
 * otherwise drainPending re-attempts it on every reconnect forever,
 * filling logs with errors that can't be acted on.
 *
 * Other Olm error variants (bad MAC, ratchet out of sync, no session
 * for normal-type) are NOT treated as terminal here: those CAN recover
 * via the SDK's existing decrypt-failure path (forgetPeerDevice +
 * refresh + retry).
 */
function isUnknownOtkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /unknown one-time key/i.test(err.message);
}

/**
 * High-level WebSocket connection state for the chat tab to render
 * "Offline" / "Reconnecting…" banners. Maps directly to the underlying
 * `WsClient` state machine; `"closing"` is collapsed into `"closed"`
 * because it's only a transient internal step.
 */
export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectionStateChangedEvt {
  state: ConnectionState;
}

/**
 * Fired on this device (and on siblings of this user) when the local user
 * deleted the conversation. `scope === "me"` means delete-for-self (peer
 * keeps the thread); `scope === "everyone"` means delete-for-all (peer's
 * devices also wiped).
 */
export interface ConversationDeletedBySelfEvt {
  peerUserId: string;
  scope: "me" | "everyone";
}

/**
 * Fired when a peer wiped this thread via `deleteConversationForEveryone`.
 * The SDK has already cleared local history + the conversation row by
 * the time this dispatches. UI should hide the chat from the list and
 * optionally toast.
 */
export interface ConversationDeletedByPeerEvt {
  peerUserId: string;
}

interface EventMap {
  message: MessageReceived;
  messageEdited: MessageEdited;
  messageDeleted: MessageDeleted;
  readReceipt: ReadReceiptEvent;
  typing: TypingEvt;
  statusChange: StatusChangeEvt;
  peerNewDevice: PeerNewDeviceEvt;
  conversationsChanged: ConversationsChangedEvt;
  conversationDeletedBySelf: ConversationDeletedBySelfEvt;
  conversationDeletedByPeer: ConversationDeletedByPeerEvt;
  connectionStateChange: ConnectionStateChangedEvt;
  messageSendFailed: MessageSendFailedEvt;
  tabConflict: TabConflictEvt;
}

type EventName = keyof EventMap;
type Listener<T extends EventName> = (event: EventMap[T]) => void;

// ── DTelecomSecureChat ──────────────────────────────────────────────────────

const RECEIVED_BATCH_FLUSH_MS = 500;
const RECEIVED_BATCH_FLUSH_SIZE = 50;
const READ_RECEIPTS_KEY = "prefs/readReceiptsEnabled";
const BLOCKED_USERS_KEY = "prefs/blockedUserIds";
/**
 * Per-peer "last read watermark we shipped to the peer FROM THIS DEVICE"
 * (sentAt of the upToMessageId). Keyed by peerUserId. Drives the
 * markRead idempotency gate so the FE's auto-fire-on-mount pattern
 * doesn't generate fresh envelopes on every reload for the same
 * watermark. Bumped by both the outbound markRead path and the
 * inbound selfEcho `read` handler (= "a sibling already shipped this
 * watermark on behalf of our user; this device shouldn't re-ship").
 */
const lastReadSentKey = (peerUserId: string): string => `lastReadSent/${peerUserId}`;

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

/**
 * Bootstrap-time check for the JS-engine globals the SDK reaches for. Fails
 * fast with an actionable error message if a required polyfill is missing,
 * rather than letting the missing global manifest as an opaque TypeError
 * mid-flow (the typical "Cannot read property 'getRandomValues' of
 * undefined" footgun on un-polyfilled React Native).
 *
 * Items checked are the minimum set the SDK can't gracefully degrade past.
 * APIs we already gate (`navigator.locks`, `indexedDB` via host-supplied
 * store) aren't checked here.
 */
function assertRuntimeReady(): void {
  // `crypto.getRandomValues` is required everywhere — it backs UUID
  // generation (via `crypto.randomUUID` natively OR via the explicit
  // v4 fallback in `device.ts`). RN hosts must install
  // `react-native-get-random-values` and import it once at app entry.
  const cryptoRef = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
  if (typeof cryptoRef?.getRandomValues !== "function") {
    throw new ChatError(
      "internal",
      "crypto.getRandomValues is not available. On React Native, install " +
        "`react-native-get-random-values` and `import \"react-native-get-random-values\"` " +
        "once at the top of your app entry file (index.js) before importing this SDK.",
    );
  }
  // `WebSocket` is provided natively by browsers and React Native. Node
  // tests can pass a fake via the transport layer.
  const wsRef = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof wsRef !== "function") {
    throw new ChatError(
      "internal",
      "WebSocket is not available in this runtime. Browser + React Native " +
        "ship it natively; Node tests should pass a `webSocketImpl` shim.",
    );
  }
  // `fetch` is required for the HTTP transport. Same story — native in
  // browsers + RN; Node 18+ has it globally; tests can pass `fetchImpl`.
  const fetchRef = (globalThis as { fetch?: unknown }).fetch;
  if (typeof fetchRef !== "function") {
    throw new ChatError(
      "internal",
      "globalThis.fetch is not available. Browser + React Native + Node 18+ " +
        "ship it natively; tests can pass a `fetchImpl` option to `connect()`.",
    );
  }
}

/**
 * True when the Web Locks API is available — required for multi-tab
 * coordination. Falls back to "always primary" in environments without it
 * (Node tests, deeply old browsers).
 */
function hasWebLocks(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { navigator?: { locks?: unknown } }).navigator !== "undefined" &&
    typeof (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks !== "undefined"
  );
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
  private logCtx!: LogContext;
  private log!: Logger;
  private conversations!: ConversationIndex;
  private status!: StatusTracker;
  private envelopeDedup!: EnvelopeDedup;
  private outbox = new Outbox({
    onTerminalFailure: (entry) => {
      // Outbox gave up. Persist status:"failed" so the UI can render a
      // failed indicator after reload, then fire the event so apps can
      // surface a "couldn't send" toast immediately.
      void (async () => {
        const msg = await this.messages.get(entry.messageId);
        if (msg && this.selfUserId !== null && msg.senderUserId === this.selfUserId) {
          await this.messages.put({ ...msg, status: "failed" });
        }
        this.dispatch("messageSendFailed", {
          peerUserId: entry.peerUserId,
          messageId: entry.messageId,
          reason: "max_attempts_exceeded",
        });
      })();
    },
  });
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

  // ── multi-tab coordination ────────────────────────────────────────────────
  // Web Locks API mediates: only the tab holding `lockName` runs the WS +
  // wire-side bootstrap. Other tabs wait silently as `secondary`. See
  // `acquireLockOrWait`, `armBackgroundLockWait`, `demoteFromPrimary`.
  private isPrimaryFlag = true; // default true so single-tab / no-Web-Locks works unchanged
  private lockName: string | null = null;
  /** Resolves the held-lock callback, releasing the lock so other tabs
   *  can promote. Called from `disconnect()`. */
  private releaseHeldLock: (() => void) | null = null;
  /** Locally-enforced inbound block list. Source of truth lives in the host
   *  app (e.g. dmeet's user-block table). The SDK only needs to know it so
   *  inbound messages from a now-blocked peer over an EXISTING Olm session
   *  are dropped before they surface to the UI. Persisted to KV so cold-
   *  start drains don't briefly leak blocked content before the host has
   *  pushed an update via `setBlockedUserIds`. */
  private blockedUserIds = new Set<string>();

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

  /**
   * Delete every persisted SDK key for `userId` from the given store.
   * Use on sign-out to reclaim space — without this, sign-out leaves
   * the user's namespace inert but present, and storage grows over
   * time as users come and go on a shared device. Other users' data on
   * the same KV instance is untouched.
   *
   * Returns the number of keys deleted (zero if `userId` had no data).
   *
   * Call `disconnect()` first if the SDK is still connected for that
   * user — wiping state behind a live SDK instance is undefined.
   */
  static async wipeUserData(store: KVStore, userId: string): Promise<number> {
    return wipeScope(store, userId);
  }

  // The constructor is private-by-convention — use connect().
  private constructor() {}

  /** Stable per-install device id. Useful for app diagnostics. */
  get currentDeviceId(): string {
    return this.deviceId;
  }

  /** The signed-in user's id, as parsed from the chat token's `sub` claim.
   *  Available after `connect()` resolves. Null only if the SDK has been
   *  disconnected without ever connecting (shouldn't happen in practice). */
  get currentUserId(): string | null {
    return this.selfUserId;
  }

  /** Sync getter — true iff this tab currently owns the chat WebSocket
   *  and is processing live mesh traffic. False means another tab of the
   *  same `(origin, user)` is primary. */
  isPrimary(): boolean {
    return this.isPrimaryFlag;
  }

  /**
   * Forcibly steal primary status from whichever other tab currently holds
   * it. On browsers with the Web Locks API: opens a new WS in this tab,
   * closes the WS in the previous primary (which gets a
   * `tabConflict { role: "secondary" }` event). Resolves once this tab's
   * WS is open and ready. On browsers without Web Locks (very old) or
   * environments without `navigator` (Node) this is a no-op resolution.
   */
  async takeOver(): Promise<void> {
    if (this.isPrimaryFlag) return;
    if (!this.lockName) return;
    if (!hasWebLocks()) return;
    await this.stealAndActivate(this.lockName);
  }

  // ── public API: messaging ──────────────────────────────────────────────────

  async sendText(peerUserId: string, text: string, opts?: { replyTo?: string }): Promise<string> {
    const event = newText(text, opts?.replyTo);
    // Re-engagement: if this peer's delete-watermark is non-zero, the
    // user (or the peer) previously wiped this conversation. Sending
    // fresh text recreates the chat; bump the watermark to NOW so any
    // stale delete-all event still flying in the at-least-once layer
    // can't retroactively kill the new conversation. See
    // `chatDeleteAll` receive case for the matching check.
    const existingWatermark = await this.messages.getDeleteWatermark(peerUserId);
    if (existingWatermark > 0) {
      await this.messages.setDeleteWatermark(peerUserId, event.clientSentAt);
    }

    // Persist locally BEFORE sendContent. sendContentInner's Option-A
    // optimistic-promotion path (0.13.3) fires status.onSendResult
    // synchronously after ws.sendChat — that dispatches the
    // StatusTracker listener, which calls messages.get(messageId) and
    // skips the persist if the row doesn't exist yet. Persisting after
    // sendContent meant the listener silently no-op'd and the
    // subsequent put({status:"pending"}) locked the row at "pending"
    // for the lifetime of the install, even though the wire send
    // succeeded. See test/status-pending-forever.test.ts.
    if (this.selfUserId) {
      await this.messages.put({
        id: event.id,
        peerUserId,
        senderUserId: this.selfUserId,
        text: event.text,
        sentAt: event.clientSentAt,
        editedAt: null,
        deletedAt: null,
        status: "pending", // bumps to "sent"/"delivered"/"read"/"failed" via the StatusTracker hook
        ...(event.replyTo !== undefined ? { replyTo: event.replyTo } : {}),
      });
      await this.bumpConversation({
        peerUserId,
        senderUserId: this.selfUserId,
        messageId: event.id,
        sentAt: event.clientSentAt,
      });
    }

    try {
      await this.sendContent(peerUserId, event, { ephemeral: false });
    } catch (err) {
      // sendContent threw (peer_unreachable / encryption failure / etc).
      // The persisted row is at "pending" with no chance of advancing —
      // mark it "failed" so retrySend can pick it up and the UI can
      // render a failed indicator. Re-throw so the caller's try/catch
      // still gets the typed ChatError.
      if (this.selfUserId) {
        const msg = await this.messages.get(event.id);
        if (msg) {
          await this.messages.put({ ...msg, status: "failed" });
          this.dispatch("statusChange", {
            peerUserId,
            messageId: event.id,
            status: "failed",
          });
        }
      }
      throw err;
    }
    await this.selfEcho(peerUserId, event);
    this.typingMgr.clearOnSend(peerUserId);
    return event.id;
  }

  /**
   * Re-send a message that previously failed (received `messageSendFailed`
   * and is in `status: "failed"` locally). Reuses the original `messageId`
   * so the peer sees one message, not two. Status transitions back to
   * `"pending"` and ladders up normally as the outbox attempts delivery.
   *
   * Throws `ChatError("internal", …)` if:
   *  - no message is stored under `messageId`
   *  - the message isn't authored by the local user
   *  - the message isn't currently in `status: "failed"`
   *  - the message is tombstoned (`deletedAt !== null`)
   *
   * Same `ChatError` codes apply as `sendText` for the wire-side failure
   * modes (`peer_unreachable`, `auth_expired`, `offline`, etc.).
   */
  async retrySend(messageId: string): Promise<void> {
    if (!this.selfUserId) {
      throw new ChatError("internal", "SDK not connected yet");
    }
    const msg = await this.messages.get(messageId);
    if (!msg) {
      throw new ChatError("internal", `message ${messageId} not found`);
    }
    if (msg.senderUserId !== this.selfUserId) {
      throw new ChatError("internal", `cannot retry someone else's message ${messageId}`);
    }
    if (msg.deletedAt !== null) {
      throw new ChatError("internal", `message ${messageId} is deleted; nothing to retry`);
    }
    if (msg.status !== "failed") {
      throw new ChatError(
        "internal",
        `message ${messageId} has status ${msg.status ?? "unset"}, expected "failed"`,
      );
    }

    // Reconstruct a text event with the SAME id and clientSentAt so the
    // peer's MessageStore upsert-by-id keeps this thread coherent if any
    // copy of the message already reached them.
    const event: ReturnType<typeof newText> = {
      v: 1,
      id: msg.id,
      type: "text",
      clientSentAt: msg.sentAt,
      text: msg.text,
      ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}),
    };

    // Reset local status to "pending" BEFORE re-sending so the UI flips
    // out of the "failed" indicator immediately. If sendContent throws
    // synchronously (peer_unreachable etc.), the row stays in pending —
    // FE catches the throw and can decide to revert to failed.
    await this.messages.put({ ...msg, status: "pending" });
    this.dispatch("statusChange", {
      peerUserId: msg.peerUserId,
      messageId: msg.id,
      status: "pending",
    });

    await this.sendContent(msg.peerUserId, event, { ephemeral: false });
    await this.selfEcho(msg.peerUserId, event);
  }

  /**
   * Edit one of YOUR previously-sent messages within the
   * `EDIT_WINDOW_MS` window (default 24h). Receivers enforce the same
   * window, so a clock-skewed sender can't sneak an out-of-window edit
   * through.
   *
   * Throws `ChatError("not_found")` if the local store doesn't have
   * `targetId`. Throws `ChatError("not_authorized")` if you didn't
   * author the original. Throws `ChatError("edit_window_expired")` if
   * the message is older than `EDIT_WINDOW_MS`.
   */
  async editMessage(peerUserId: string, targetId: string, newText: string): Promise<string> {
    // Sender-side validation up front so we don't fire a doomed wire
    // send. The receiver enforces the same rules, but failing fast here
    // gives the UI a clean exception and avoids burning OTKs.
    const original = await this.messages.get(targetId);
    if (!original) {
      throw new ChatError("not_found", `message ${targetId} not in local store`);
    }
    if (this.selfUserId === null || original.senderUserId !== this.selfUserId) {
      throw new ChatError("not_authorized", "cannot edit a message you didn't send");
    }
    if (Date.now() - original.sentAt > EDIT_WINDOW_MS) {
      throw new ChatError(
        "edit_window_expired",
        `message ${targetId} is older than the ${EDIT_WINDOW_MS}ms edit window`,
      );
    }
    const event = newEdit(targetId, newText);
    // Durable wire delivery, but no push: an edit to a message the peer
    // has already read shouldn't wake them. Their UI updates silently on
    // next foreground.
    await this.sendContent(peerUserId, event, { ephemeral: false, notifyPush: false });
    if (this.selfUserId) {
      await this.messages.applyEdit({
        targetId,
        editorUserId: this.selfUserId,
        newText,
        editedAt: event.clientSentAt,
        originalSentAt: original.sentAt,
      });
    }
    await this.selfEcho(peerUserId, event);
    return event.id;
  }

  /**
   * Delete (tombstone) one of YOUR previously-sent messages. The `text`
   * is wiped, `deletedAt` is set. Receivers see the same tombstone via
   * their `messageDeleted` event. UI: render "this message was deleted"
   * when `deletedAt !== null`. No time-window restriction.
   *
   * Throws `ChatError("not_found")` if the local store doesn't have
   * `targetId`. Throws `ChatError("not_authorized")` if you didn't
   * author the original (the receiver-side check would also reject this,
   * but failing fast here avoids burning OTKs and gives the UI a clean
   * exception).
   */
  async deleteMessage(peerUserId: string, targetId: string): Promise<string> {
    const original = await this.messages.get(targetId);
    if (!original) {
      throw new ChatError("not_found", `message ${targetId} not in local store`);
    }
    if (this.selfUserId === null || original.senderUserId !== this.selfUserId) {
      throw new ChatError("not_authorized", "cannot delete a message you didn't send");
    }
    const event = newDelete(targetId);
    // Durable wire delivery, but no push: a tombstone shouldn't wake
    // the peer. Their UI applies the tombstone silently on next
    // foreground.
    await this.sendContent(peerUserId, event, { ephemeral: false, notifyPush: false });
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
    // Always advance the LOCAL read watermark — that's a private UX state
    // and is the only thing the conversation list's unread count depends
    // on. The wire-level read receipt to the sender is gated by
    // setReadReceiptsEnabled.
    await this.bumpReadWatermark(peerUserId, upToMessageId);
    if (!(await this.areReadReceiptsEnabled())) return;

    // Idempotency gate. FE consumers (dmeet web + RN) auto-fire markRead
    // from a useEffect that depends on the latest inbound messageId —
    // which is stable across reloads. Their in-memory dedup ref resets
    // on component mount, so every page reload would otherwise generate
    // a fresh durable envelope to all of peer's devices AND a selfEcho
    // fanout, accumulating in the backend's pending queue (each ~500B,
    // 4-6 devices, multiple reloads per session). The lastReadSent
    // watermark survives reload so we skip the wire when the requested
    // upToMessageId doesn't advance what we've already shipped.
    const target = await this.messages.get(upToMessageId);
    if (!target) {
      // Unknown messageId — can't anchor against sentAt. Skip the wire
      // to avoid shipping a dangling reference; a future markRead with
      // a known id will fire.
      return;
    }
    const lastSent = await this.getLastReadSent(peerUserId);
    if (lastSent !== null && target.sentAt <= lastSent) {
      return;
    }

    const event = newRead(upToMessageId);
    // ephemeral:false (durable) + notifyPush:false (silent). Read
    // receipts fan out to ALL of the peer's devices via the chatSend
    // targets; without durable delivery, any peer device offline at
    // the moment of markRead permanently misses the receipt and its
    // UI never advances to "read" for the affected messages — a real
    // bug observed in multi-device users after 0.13.4 switched this
    // path to ephemeral. The notifyPush hint (0.13.5) suppresses the
    // push notification at the node so durable delivery doesn't
    // mean "wake up the offline target", which was the original
    // motivation for the ephemeral hack in 0.13.4.
    //
    // Requires node ≥ commit a193b45d to honor notifyPush; older
    // nodes would push for read receipts to offline targets.
    await this.sendContent(peerUserId, event, { ephemeral: false, notifyPush: false });
    await this.selfEcho(peerUserId, event);

    // Persist AFTER successful send. If sendContent throws (peer_unreachable
    // / wire error), lastReadSent stays put and the next markRead retries.
    await this.setLastReadSent(peerUserId, target.sentAt);
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

  /**
   * Return all conversations this device knows about, sorted most-recent-
   * activity first. Derived from the local message store + a per-peer
   * read-watermark; survives reloads via the KV adapter.
   *
   * A brand-new device starts with an empty list and accumulates entries as
   * peers send messages (or this user sends them). There is no historical
   * sync — that matches the fanout-multi-device decision in
   * `secure-chat-plan.md` §17.
   *
   * Subscribe to `conversationsChanged` to re-render the list incrementally.
   */
  listConversations(): Promise<Conversation[]> {
    return this.conversations.list();
  }

  // ── public API: local inbound block filter ─────────────────────────────────
  //
  // The host app owns the block list (e.g. dmeet's /api/users/block-user).
  // The chat backend reads the same user_to_user_block rows to silently
  // filter at claim_all + the envelope webhook. But Olm sessions ESTABLISHED
  // before the block was set aren't torn down — see plan §14 — so the
  // recipient SDK still has to drop inbound from blocked peers locally.
  // These methods are how the host pushes the current list (and reads back
  // what the SDK currently enforces).

  /** Replace the locally-enforced inbound block set. Call on connect
   *  (or via `initialBlockedUserIds`) and on every change in the host's
   *  block UI. Persists to KV so the next cold start enforces the same
   *  set during the offline-pending drain. */
  async setBlockedUserIds(ids: readonly string[]): Promise<void> {
    this.blockedUserIds = new Set(ids);
    await this.store.setString(BLOCKED_USERS_KEY, JSON.stringify([...this.blockedUserIds]));
  }

  /** Read the SDK's current locally-enforced inbound block set. For
   *  diagnostics — the source of truth is the host's user-block UX. */
  getLocallyBlockedUserIds(): string[] {
    return [...this.blockedUserIds];
  }

  // ── public API: thread housekeeping ────────────────────────────────────────

  /**
   * Delete the thread on EVERY device of YOUR user (multi-device). Wipes
   * local messages + the conversation index row, advances the per-peer
   * delete-watermark to now, and self-echoes a `chatDeleteSelf` to your
   * siblings so they wipe too.
   *
   * The peer is NOT signaled — they still have the thread on their side
   * and can keep sending. Future inbound messages re-create the
   * conversation. Olm sessions are untouched.
   *
   * Use case: "remove this chat from my list, on all my devices."
   *
   * Throws nothing for a thread that doesn't exist (idempotent).
   */
  async deleteConversationForMe(peerUserId: string): Promise<void> {
    await this.messages.deleteForPeer(peerUserId);
    await this.conversations.delete(peerUserId);
    // Bump the watermark so a delete-for-everyone from the peer in flight
    // at the moment we recreate the conversation can't retroactively
    // re-wipe it. (For symmetry with the everyone-delete path.)
    await this.messages.setDeleteWatermark(peerUserId, Date.now());
    if (this.selfUserId) {
      const event = newChatDeleteSelf(peerUserId);
      await this.selfEcho(peerUserId, event);
    }
    await this.emitConversationsChanged([peerUserId]);
    this.dispatch("conversationDeletedBySelf", { peerUserId, scope: "me" });
  }

  /**
   * Delete the thread on EVERY device of EVERY participant — yours and
   * the peer's. Sends a `chatDeleteAll` content event to the peer
   * (their devices wipe + the chat disappears from their list and
   * fires `conversationDeletedByPeer` for their UI). Self-echoes to
   * your siblings so they wipe too.
   *
   * One-shot semantics: receivers track a per-peer delete-watermark
   * and drop any delete-all event whose `clientSentAt` is ≤ the
   * watermark. The first outbound text after a delete-all bumps the
   * watermark to "now", so a stale delete-all replayed from offline
   * storage cannot retroactively kill a re-engaged conversation.
   *
   * Olm sessions survive — if either side sends to the other later,
   * the conversation re-creates from scratch.
   *
   * Throws `ChatError("peer_unreachable")` if the peer has no
   * registered devices (same shape as a `sendText` to an unreachable
   * peer). Local state is wiped regardless — the at-least-once
   * delivery layer will eventually land the event on the peer if/when
   * they come back online.
   */
  async deleteConversationForEveryone(peerUserId: string): Promise<void> {
    const event = newChatDeleteAll();
    // Wipe local FIRST so the UI is responsive even if the wire send
    // takes a moment. At-least-once delivery handles eventual landing
    // on the peer.
    await this.messages.deleteForPeer(peerUserId);
    await this.conversations.delete(peerUserId);
    await this.messages.setDeleteWatermark(peerUserId, event.clientSentAt);
    await this.emitConversationsChanged([peerUserId]);
    this.dispatch("conversationDeletedBySelf", { peerUserId, scope: "everyone" });
    // Send to peer. Self-echo to siblings (they wipe via the
    // "chatDeleteAll" inner case in the selfEcho switch).
    try {
      // notifyPush:false — wiping a conversation shouldn't wake the peer.
      // Their UI applies the tombstone silently on next foreground.
      await this.sendContent(peerUserId, event, { ephemeral: false, notifyPush: false });
    } finally {
      // Best-effort: even if the peer send threw (peer_unreachable),
      // siblings should still wipe. They'll receive via self-echo
      // (which uses a separate fanout to selfUserId).
      await this.selfEcho(peerUserId, event);
    }
  }

  /**
   * @deprecated since 0.12.0 — use {@link deleteConversationForMe} for
   * multi-device-consistent local wipe, or
   * {@link deleteConversationForEveryone} to also wipe the peer's side.
   * This method only clears the device it's called on; siblings remain
   * out of sync. Will be removed in a future version.
   */
  async deleteConversation(peerUserId: string): Promise<void> {
    await this.messages.deleteForPeer(peerUserId);
    await this.conversations.delete(peerUserId);
    await this.emitConversationsChanged([peerUserId]);
  }

  /** Current sum of unread messages across every conversation. Use in the
   *  app's nav-level badge; subscribe to `conversationsChanged` for live
   *  updates (the event payload also carries this same value). */
  getTotalUnreadCount(): Promise<number> {
    return this.conversations.totalUnread();
  }

  /**
   * Snapshot of internal SDK state for debugging. Safe to dump into a
   * bug report — no ciphertext, no key material, no plaintext message
   * content. See {@link ChatDiagnostics} for the shape.
   *
   * Useful flows:
   *
   * - User reports "messages don't appear": call this, look at
   *   `bundleCache` (does the peer have any cached devices?),
   *   `envelopeDedupSize` (is dedup unusually large?), and
   *   `recentEvents` for the last ~256 internal log lines.
   *
   * - User reports "tons of network requests": call this, grep
   *   `recentEvents` for `[http]` lines to count claim_all /
   *   list_devices firings and see what triggered them.
   *
   * Independent of `ConnectOptions.debug`. The recent-events ring
   * buffer is always populated.
   */
  getDiagnostics(): ChatDiagnostics {
    const sessionsDiag = this.sessions.diagnostics();
    const peerDevicesDiag = this.peerDevices.diagnostics();
    return {
      logLevel: this.logCtx.getLevel(),
      selfUserId: this.selfUserId,
      deviceId: this.deviceId,
      isPrimary: this.isPrimaryFlag,
      wsState: this.wsState,
      bundleCache: sessionsDiag.bundleCache,
      peerDevicesCache: peerDevicesDiag,
      inflightClaimAll: sessionsDiag.inflightClaimAll,
      inflightDiscovery: sessionsDiag.inflightDiscovery,
      envelopeDedupSize: this.envelopeDedup.size(),
      recentEvents: this.logCtx.recentEvents(),
    };
  }

  // ── internals: block-list persistence ──────────────────────────────────────

  private async loadBlockedUserIds(): Promise<void> {
    const raw = await this.store.getString(BLOCKED_USERS_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.blockedUserIds = new Set(parsed.filter((x): x is string => typeof x === "string"));
      }
    } catch {
      // ignore malformed
    }
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
    // Release the cross-tab lock so a secondary tab can promote itself.
    // Safe to call when not actually holding (no-op).
    if (this.releaseHeldLock) {
      this.releaseHeldLock();
      this.releaseHeldLock = null;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async bootstrap(opts: ConnectOptions): Promise<void> {
    assertRuntimeReady();

    if (!opts.selfUserId) {
      throw new ChatError(
        "internal",
        "connect() requires `selfUserId` — pass the authenticated user's id " +
          "(Privy `did:privy:...` for dmeet). SDK uses it to namespace all " +
          "persisted state per user.",
      );
    }
    this.selfUserId = opts.selfUserId;

    // Build the log context BEFORE anything else so even the early
    // bootstrap steps are captured in the ring buffer. The console-emit
    // gate respects opts.debug / localStorage; if neither is set we're
    // silent on console but still recording to the ring (cheap; bounded).
    this.logCtx = new LogContext(opts.debug);
    this.log = this.logCtx.makeLogger("sdk");
    this.log.info("bootstrap", { selfUserId: this.selfUserId, level: this.logCtx.getLevel() });

    // Wrap the consumer-provided store with a per-user scope BEFORE any
    // subsystem touches it. All persisted SDK state (deviceId, Olm pickle,
    // Olm sessions, message store, conversation index, key-bundle cache,
    // outbox, status, blocked list, verifiedDevice/*) flows through this
    // wrapper and lives under `u/<selfUserId>/...`.
    const rawStore: KVStore = opts.store ?? new WebKVStore();
    // First-run migration: for installs that pre-date the scoping (anything
    // built against secure-chat-client@<0.9.0), the legacy single-user data
    // lives at top-level keys ("deviceId", "olm/account", "convindex/...").
    // If the scoped namespace is empty AND legacy keys exist, copy them
    // into this user's namespace. The previous single-user install belonged
    // to whoever is signing in now (multi-user wasn't supported before this
    // version), so adopting that data is the safe, non-destructive default.
    await migrateLegacyKeys(rawStore, this.selfUserId);
    this.store = new ScopedKVStore(rawStore, this.selfUserId);

    this.crypto = opts.crypto ?? new OlmCryptoAdapter({
      store: this.store,
      log: this.logCtx.makeLogger("crypto"),
    });
    await this.crypto.init();

    this.deviceId = await loadOrCreateDeviceId(this.store);

    this.http = new HttpClient({
      apiBaseURL: opts.apiBaseURL,
      fetchChatToken: opts.fetchChatToken,
      fetchHttpBearer: opts.fetchHttpBearer,
      log: this.logCtx.makeLogger("http"),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });

    // Seed the token cache and verify the chat token's `sub` matches the
    // declared selfUserId. Mismatch means the consumer's auth state is
    // out of sync with the SDK's scope, which would otherwise silently
    // persist user A's data under user B's namespace.
    const mint = await this.http.getMint(this.deviceId);
    const sub = parseSubFromJwt(mint.chatToken);
    if (sub !== this.selfUserId) {
      throw new ChatError(
        "internal",
        `chat token sub (${sub ?? "null"}) does not match selfUserId (${this.selfUserId}). ` +
          `Caller's auth state is out of sync with the user passed to connect().`,
      );
    }
    this.lockName = `dtelecom-chat:${opts.apiBaseURL}:${this.selfUserId}`;

    this.keyBundle = new KeyBundleManager({ http: this.http, crypto: this.crypto, deviceId: this.deviceId });
    // Note: ensureKeyBundle is moved into activatePrimary — secondary tabs
    // skip it (the primary tab uploads the bundle; secondary doesn't write
    // server state).

    this.sessions = new SessionManager({
      http: this.http,
      crypto: this.crypto,
      selfDeviceId: this.deviceId,
      selfUserId: this.selfUserId,
      log: this.logCtx.makeLogger("sessions"),
      // Background discovery: every outbound encrypt kicks off a cheap
      // list_devices in parallel; if a peer has a device the bundleCache
      // didn't know about, the SAME plaintext is encrypted for it and
      // shipped via the WS path below.
      ...(opts.backgroundDiscovery !== undefined && { backgroundDiscovery: opts.backgroundDiscovery }),
      ...(opts.backgroundDiscoveryFloorMs !== undefined && {
        backgroundDiscoveryFloorMs: opts.backgroundDiscoveryFloorMs,
      }),
      onCatchUpEnvelope: (env) => this.shipCatchUpEnvelope(env),
    });
    this.peerDevices = new PeerDeviceCache({ http: this.http, selfDeviceId: this.deviceId });
    this.messages = new MessageStore(this.store);
    this.conversations = new ConversationIndex(
      this.store,
      this.messages,
      () => this.selfUserId,
    );
    await this.conversations.load();
    // EnvelopeDedup must hydrate BEFORE drainPending or any inbound frame
    // processing — see handleInboundCiphertext for why duplicate-decrypt
    // before dedup is hydrated would corrupt the Olm session.
    this.envelopeDedup = new EnvelopeDedup(this.store, this.logCtx.makeLogger("dedup"));
    await this.envelopeDedup.init();
    // Hydrate the block list — KV first (best-effort), then overlay any
    // caller-provided initial value so the explicit option wins.
    await this.loadBlockedUserIds();
    if (opts.initialBlockedUserIds) {
      await this.setBlockedUserIds(opts.initialBlockedUserIds);
    }
    this.status = new StatusTracker();
    this.status.on((messageId, status, peerUserId) => {
      // Mirror the transition into the persisted message row so the
      // last-known status survives reload. Inbound rows have a different
      // senderUserId (the peer) so we skip them — status only applies to
      // OUR outbound text. Edits/deletes track status separately under
      // their own event id which isn't in MessageStore, so .get() returns
      // null and we just emit the event without persistence.
      void (async () => {
        const msg = await this.messages.get(messageId);
        if (msg && this.selfUserId !== null && msg.senderUserId === this.selfUserId) {
          await this.messages.put({ ...msg, status });
        }
      })();
      this.dispatch("statusChange", { peerUserId, messageId, status });
      // 0.13.3: when StatusTracker downgrades to "failed" via the
      // all-targets-error path in onSendResult, surface the same
      // messageSendFailed event the outbox-max-retries path fires.
      // Reason distinguishes the two so UI / telemetry can react. The
      // outbox-max-retries path fires its own messageSendFailed via
      // onTerminalFailure (see Outbox construction above) and that
      // path doesn't go through the StatusTracker downgrade — so we
      // won't double-fire here.
      if (status === "failed") {
        this.dispatch("messageSendFailed", {
          peerUserId,
          messageId,
          reason: "server_rejected",
        });
      }
    });

    this.typingMgr = new TypingManager((peerUserId, state) => {
      // Fire-and-forget; we don't await typing ephemeral fanout.
      // notifyPush:false is a belt-and-suspenders — ephemerals skip
      // webhook today, so this hint only matters if that ever changes.
      this.sendContent(peerUserId, newTyping(state), { ephemeral: true, notifyPush: false }).catch(() => {});
    });

    // Construct the WS client BUT don't connect it yet — connection is
    // gated on primary-tab status. Strip a trailing /chat/ws path if the
    // discovery returned one; WsClient appends it.
    const nodeUrl = mint.chatNodeWsUrl.replace(/\/chat\/ws\/?$/, "");
    this.ws = new WsClient({
      nodeBaseURL: nodeUrl,
      getToken: () => this.http.getToken(this.deviceId),
      onFrame: (f) => this.onFrame(f),
      onState: (s) => this.onWsState(s),
    });

    // Acquire (or fail to acquire) the cross-tab lock. If we're primary,
    // activatePrimary uploads keys + opens the WS. If we're secondary, we
    // emit `tabConflict` and arm a background wait so we can promote if
    // the primary tab disconnects.
    const role = await this.acquireLockOrWait();
    this.isPrimaryFlag = role === "primary";
    if (this.isPrimaryFlag) {
      await this.activatePrimary();
    } else {
      this.dispatch("tabConflict", { role: "secondary", activeAt: Date.now() });
      if (this.lockName) this.armBackgroundLockWait(this.lockName);
    }
  }

  /**
   * Primary-side activation. Uploads the device's bundle (if not already
   * present), connects the WS, and lets `onWsState("open")` drive the
   * drainPending / topup / refresh-self-bundles flow. Idempotent — safe to
   * call from both initial bootstrap and from a takeOver-promotion path.
   */
  private async activatePrimary(): Promise<void> {
    await this.keyBundle.ensureKeyBundle();
    // After a previous demote we may have closed the WS — re-open it.
    // WsClient.connect is safe to call on an already-open WS (no-op).
    await this.ws.connect();
    // drainPending + topUpIfNeeded + refreshSelfBundles run via the
    // onWsState("open") hook — no need to repeat them here.
  }

  // ── multi-tab coordination internals ──────────────────────────────────────

  /**
   * Resolve to `"primary"` if this tab grabs the cross-tab lock immediately,
   * or `"secondary"` if another tab already holds it. The lock is held in
   * the background until `releaseHeldLock()` is called (from `disconnect`)
   * or until another tab steals it via `takeOver`.
   *
   * No-op fallback: returns `"primary"` on environments without
   * `navigator.locks` (Node tests, very old browsers).
   */
  private acquireLockOrWait(): Promise<"primary" | "secondary"> {
    if (!hasWebLocks() || !this.lockName) {
      return Promise.resolve("primary");
    }
    const name = this.lockName;
    return new Promise((settle) => {
      let settled = false;
      const lockHold = new Promise<void>((release) => {
        this.releaseHeldLock = release;
      });
      const req = navigator.locks.request(
        name,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (lock === null) {
            // Someone else is holding it — we're secondary.
            if (!settled) {
              settled = true;
              settle("secondary");
            }
            return;
          }
          if (!settled) {
            settled = true;
            settle("primary");
          }
          await lockHold;
        },
      );
      req.catch(() => {
        // Lock was stolen after acquisition (another tab called takeOver).
        if (this.isPrimaryFlag) void this.demoteFromPrimary();
      });
    });
  }

  /**
   * Queue an exclusive lock request without `ifAvailable` — it waits until
   * the lock is freeable, then we promote. Used while in secondary state
   * so we can auto-recover when the primary tab disconnects.
   */
  private armBackgroundLockWait(name: string): void {
    if (!hasWebLocks()) return;
    const lockHold = new Promise<void>((release) => {
      this.releaseHeldLock = release;
    });
    navigator.locks
      .request(name, { mode: "exclusive" }, async () => {
        if (!this.isPrimaryFlag) {
          this.isPrimaryFlag = true;
          try {
            await this.activatePrimary();
            this.dispatch("tabConflict", { role: "primary", activeAt: Date.now() });
          } catch {
            // Activation failed; demote back so we stay consistent.
            this.isPrimaryFlag = false;
          }
        }
        await lockHold;
      })
      .catch(() => {
        if (this.isPrimaryFlag) void this.demoteFromPrimary();
      });
  }

  /**
   * Steal the lock + activate. Used by `takeOver` to forcibly become
   * primary. Awaits the WS being open so callers know the SDK is ready
   * when this returns.
   */
  private stealAndActivate(name: string): Promise<void> {
    if (!hasWebLocks()) return Promise.resolve();
    return new Promise<void>((resolveActive, rejectActive) => {
      const lockHold = new Promise<void>((release) => {
        this.releaseHeldLock = release;
      });
      navigator.locks
        .request(name, { mode: "exclusive", steal: true }, async () => {
          try {
            this.isPrimaryFlag = true;
            await this.activatePrimary();
            this.dispatch("tabConflict", { role: "primary", activeAt: Date.now() });
            resolveActive();
          } catch (err) {
            this.isPrimaryFlag = false;
            rejectActive(err as Error);
          }
          await lockHold;
        })
        .catch(() => {
          if (this.isPrimaryFlag) void this.demoteFromPrimary();
        });
    });
  }

  /**
   * Demote from primary: close the WS, emit the role-change event, and
   * re-arm a background wait so we can be promoted again later. Called
   * when another tab steals our lock.
   */
  private async demoteFromPrimary(): Promise<void> {
    if (!this.isPrimaryFlag) return;
    this.isPrimaryFlag = false;
    try {
      await this.ws.close();
    } catch {
      // ignore — best-effort cleanup
    }
    this.dispatch("tabConflict", { role: "secondary", activeAt: Date.now() });
    if (this.lockName) this.armBackgroundLockWait(this.lockName);
  }

  /**
   * State-listener for the underlying WsClient. On every transition to
   * "open" (initial connect AND auto-reconnect), drain any queued
   * outbound sends and re-pull pending offline envelopes — closes the
   * gap during disconnect.
   */
  private wsState: ConnectionState = "closed";

  private onWsState(s: string): void {
    // Surface the state change to apps so the UI can render an offline /
    // reconnecting banner. Collapse the transient "closing" step into
    // "closed" — apps don't care about the difference.
    const exposed: ConnectionState =
      s === "open" ? "open" : s === "reconnecting" ? "reconnecting" : s === "connecting" ? "connecting" : "closed";
    this.wsState = exposed;
    this.log.info("ws state", { state: exposed });
    this.dispatch("connectionStateChange", { state: exposed });

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
              envelopeUuid: env.envelopeUuid,
              peerUserId: env.senderUserId,
              peerDeviceId: env.senderDeviceId,
              ciphertext: env.ciphertext,
              msgType: env.msgType,
              source: "drain",
            });
            ackUuids.push(env.envelopeUuid);
          } catch (err) {
            // Terminal failures: HTTP-ack to clear the queue. Otherwise
            // drainPending would re-attempt the same unrecoverable
            // ciphertext on every reconnect, filling logs with errors
            // that can't be acted on. See isUnknownOtkError JSDoc.
            //
            // Transient failures (everything else) keep the envelope on
            // the queue so a future reconnect can retry — the SDK's
            // decrypt-failure recovery path (forgetPeerDevice + refresh
            // + retry inside handleInboundCiphertext) can fix some of
            // those, but if it can't, this drain attempt is a no-op.
            if (isUnknownOtkError(err)) {
              this.log.warn(
                "delivery: envelope permanently undecryptable (unknown OTK), acking to clear queue",
                {
                  envelopeUuid: env.envelopeUuid,
                  peerUserId: env.senderUserId,
                  peerDeviceId: env.senderDeviceId,
                  err: err instanceof Error ? err.message : String(err),
                },
              );
              ackUuids.push(env.envelopeUuid);
            } else {
              this.log.debug("delivery: drain envelope failed transiently — will retry", {
                envelopeUuid: env.envelopeUuid,
                err: err instanceof Error ? err.message : String(err),
              });
            }
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
        envelopeUuid: frame.envelopeUuid,
        peerUserId: frame.senderUserId,
        peerDeviceId: frame.senderDeviceId,
        ciphertext: frame.ciphertext,
        msgType: frame.msgType,
        source: "live",
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

  /**
   * Process a decrypted-or-to-be-decrypted inbound envelope. Sources:
   *   - "live": came in via a chatEnvelope WS frame. On success the SDK
   *     sends back a chatEnvelopeAck so the sender's node promotes the
   *     status from "queued" to "live."
   *   - "drain": came in via HTTP /envelopes/pending. The sender already
   *     saw `StatusStored` (we got here via the webhook path) and acks
   *     are over HTTP via /envelopes/ack — no WS ack needed.
   *
   * Both paths feed the envelopeUuid into the dedup set BEFORE decrypt,
   * so a duplicate (retry-publish + drain landing on the same envelope)
   * is dropped pre-ratchet. Olm rejects replays as session corruption,
   * which would otherwise trigger the heavy forgetPeerDevice recovery
   * path and nuke the session.
   */
  private async handleInboundCiphertext(opts: {
    envelopeUuid: string;
    peerUserId: string;
    peerDeviceId: string;
    ciphertext: string;
    msgType: "prekey" | "normal";
    source: "live" | "drain";
  }): Promise<void> {
    this.log.debug("delivery: inbound", {
      envelopeUuid: opts.envelopeUuid,
      peerUserId: opts.peerUserId,
      peerDeviceId: opts.peerDeviceId,
      msgType: opts.msgType,
      source: opts.source,
    });
    // Pre-decrypt dedup. Two delivery paths plus sender-side retries make
    // duplicates expected — see EnvelopeDedup for the rationale.
    if (await this.envelopeDedup.has(opts.envelopeUuid)) {
      // Already processed via the other path or an earlier retry. Re-ack
      // so the sender's status tracker promotes correctly even if our
      // first ack got lost in transit (e.g., reconnect dropped the
      // pending ack send).
      if (opts.source === "live") {
        this.log.debug("delivery: dedup hit → re-ack", { envelopeUuid: opts.envelopeUuid });
        this.ws.sendEnvelopeAck({
          envelopeUuid: opts.envelopeUuid,
          senderUserId: opts.peerUserId,
          senderDeviceId: opts.peerDeviceId,
        });
      }
      return;
    }
    // Reserve the uuid BEFORE decrypt so two concurrent deliveries of the
    // same envelope (live WS + drainPending race) don't both attempt
    // decrypt — the second would fail Olm replay and corrupt the
    // session. If decrypt or dispatch fails, we ROLL BACK the dedup
    // entry in the catch block so a retry / drainPending on next
    // reconnect can try again. Without that rollback, a single decrypt
    // failure permanently poisoned the dedup and silently dropped every
    // subsequent redelivery of the same envelope (bug fixed in 0.12.1).
    await this.envelopeDedup.add(opts.envelopeUuid);

    try {
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
      if (!event) return; // unknown / malformed: drop silently (dedup STAYS — replaying won't help)
      await this.dispatchInboundEvent(opts.peerUserId, opts.peerDeviceId, event);
    } catch (err) {
      // Decrypt or dispatch failed irrecoverably. Roll back the dedup
      // entry so the at-least-once layer (sender retry / drainPending
      // on next reconnect) can retry processing. Olm replay protection
      // still guards the in-process race via the pre-decrypt add above.
      await this.envelopeDedup.remove(opts.envelopeUuid).catch(() => {});
      throw err;
    }

    // ack-after-store: dispatchInboundEvent has just persisted the event
    // (text → messages.put, etc.). The chatEnvelopeAck signals the node
    // to promote the sender's chatSendResult to "live." Only WS-delivered
    // envelopes get acked over WS; drain-path envelopes already used the
    // HTTP /envelopes/ack route and the sender already saw "stored."
    if (opts.source === "live") {
      this.ws.sendEnvelopeAck({
        envelopeUuid: opts.envelopeUuid,
        senderUserId: opts.peerUserId,
        senderDeviceId: opts.peerDeviceId,
      });
    }
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

  /**
   * Bump the conversation index for a stored text message (inbound, outbound,
   * or self-echo) and emit `conversationsChanged` if the row changed. Edits
   * and deletes don't bump the index — only the original text counts as
   * "activity," and the snippet is read fresh from MessageStore at list()
   * time so edits show up automatically.
   */
  private async bumpConversation(opts: {
    peerUserId: string;
    senderUserId: string;
    messageId: string;
    sentAt: number;
  }): Promise<void> {
    const changed = await this.conversations.onMessageStored(opts);
    if (changed) {
      await this.emitConversationsChanged([opts.peerUserId]);
    }
  }

  /**
   * Advance the local read watermark for `peerUserId`. Driven by outbound
   * markRead AND by self-echoed read events from sibling devices, so the
   * conversation list converges across own installs.
   */
  private async bumpReadWatermark(peerUserId: string, upToMessageId: string): Promise<void> {
    const target = await this.messages.get(upToMessageId);
    if (!target) return;
    const changed = await this.conversations.markReadUpTo(peerUserId, target.sentAt);
    if (changed) {
      await this.emitConversationsChanged([peerUserId]);
    }
  }

  /**
   * Read the highest read-watermark sentAt this device has SHIPPED
   * to `peerUserId` (i.e., the upToMessageId.sentAt of the last
   * successful markRead wire send, or the highest selfEcho-of-read
   * sentAt observed from a sibling device). Returns null if we've
   * never shipped a read receipt to this peer from this device.
   *
   * Distinct from the LOCAL read watermark (`conversations.markReadUpTo`):
   * that one reflects "which messages did we display to the user",
   * this one reflects "which watermark have we told peer about".
   * They're usually equal but diverge when the read-receipts pref is
   * off (we mark locally but never ship) or when a sibling device
   * shipped first (we adopt without re-shipping).
   */
  private async getLastReadSent(peerUserId: string): Promise<number | null> {
    const raw = await this.store.getString(lastReadSentKey(peerUserId));
    if (!raw) return null;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Persist the highest read-watermark sentAt this device has shipped
   * (or that a sibling shipped on our user's behalf). Idempotent —
   * never moves backwards.
   */
  private async setLastReadSent(peerUserId: string, sentAt: number): Promise<void> {
    const current = await this.getLastReadSent(peerUserId);
    if (current !== null && current >= sentAt) return;
    await this.store.setString(lastReadSentKey(peerUserId), String(sentAt));
  }

  /** Central dispatch for `conversationsChanged` — always computes the
   *  current `totalUnread` so the badge updates from a single listener. */
  private async emitConversationsChanged(changed: string[]): Promise<void> {
    const totalUnread = await this.conversations.totalUnread();
    this.dispatch("conversationsChanged", { changed, totalUnread });
  }

  private async dispatchInboundEvent(
    peerUserId: string,
    peerDeviceId: string,
    event: ContentEvent,
  ): Promise<void> {
    // Local inbound block filter (plan §14 layer 3 / contract §2.10). We
    // dropped the SDK's block-list HTTP methods because the host owns that
    // state, but Olm sessions established BEFORE a block was set aren't
    // torn down — so inbound from a now-blocked peer can still arrive
    // here. Decrypt has already run (the ratchet must advance to stay in
    // sync with the peer); we just don't persist, don't surface to the UI,
    // and only ack content-bearing events so the offline queue drains
    // normally. selfEcho is exempt because its `peerUserId` is selfUserId
    // (the user can't block themselves).
    if (this.blockedUserIds.has(peerUserId)) {
      if (event.type === "text" || event.type === "edit" || event.type === "delete") {
        this.queueReceivedAck(peerUserId, peerDeviceId, event.id);
      }
      return;
    }

    switch (event.type) {
      case "text": {
        // Re-engagement (inbound side): if the peer is sending us text,
        // they have the conversation. Any earlier delete-all from them
        // still flying in the at-least-once layer must be stale — bump
        // the watermark to this text's clientSentAt so the delete-all
        // is dropped on arrival.
        const existingWatermark = await this.messages.getDeleteWatermark(peerUserId);
        if (existingWatermark > 0 && event.clientSentAt > existingWatermark) {
          await this.messages.setDeleteWatermark(peerUserId, event.clientSentAt);
        }
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
        await this.bumpConversation({
          peerUserId,
          senderUserId: peerUserId,
          messageId: event.id,
          sentAt: event.clientSentAt,
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
      case "chatDeleteSelf": {
        // Peer-authored chatDeleteSelf shouldn't reach a peer's device
        // — by design these events are self-echo-only. If somehow one
        // arrives over a peer Olm session, drop it (the wire layer
        // can't enforce semantics, only the SDK can). Dispatching it
        // here would let a peer wipe the local user's other threads,
        // which is not the contract.
        return;
      }
      case "chatDeleteAll": {
        // One-shot guard: ignore if the event predates our recorded
        // watermark for this peer. Sending fresh text bumps the
        // watermark to "now", so a stale delete-all replayed from
        // offline storage after the user re-engages cannot retro-wipe
        // the new conversation.
        const watermark = await this.messages.getDeleteWatermark(peerUserId);
        if (event.clientSentAt <= watermark) {
          // Still ack so the sender's status tracker can promote and
          // the envelope doesn't sit in /envelopes/pending forever.
          this.queueReceivedAck(peerUserId, peerDeviceId, event.id);
          return;
        }
        await this.messages.deleteForPeer(peerUserId);
        await this.conversations.delete(peerUserId);
        await this.messages.setDeleteWatermark(peerUserId, event.clientSentAt);
        await this.emitConversationsChanged([peerUserId]);
        this.dispatch("conversationDeletedByPeer", { peerUserId });
        this.queueReceivedAck(peerUserId, peerDeviceId, event.id);
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
              // Sibling devices persist a baseline "pending" so that
              // (a) the FE has a stable status to render before peer
              // events arrive, and (b) the StatusTracker listener's
              // mirror-into-message_store path finds a row to update.
              // Without this, on reload the FE rendered (status ??
              // "sent") for this row, which displayed single ✓ even
              // though the user had seen ✓✓ in real-time before
              // refresh. See test/sibling-status-sync.test.ts.
              status: "pending",
              ...(inner.replyTo !== undefined ? { replyTo: inner.replyTo } : {}),
            });
            await this.bumpConversation({
              peerUserId: originalPeer,
              senderUserId: peerUserId, // self
              messageId: inner.id,
              sentAt: inner.clientSentAt,
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

            // Register the message with the StatusTracker on this
            // sibling device so future `received` / `read` events
            // from the original peer (which fan out to ALL of our
            // devices) actually advance status here too. Without
            // this, onReceived/onRead silently no-op because they
            // can't find an outbound entry for messageId, and the
            // listener that mirrors status transitions into
            // message_store never fires → status stays "pending"
            // and the FE shows single ✓ on reload.
            //
            // Sibling doesn't know the originating envelopeUuids
            // (those live on the sender's session), but
            // onReceived/onRead key on (peerUserId, peerDeviceId,
            // messageId), so synthetic placeholders for the map
            // keys are fine — only the device set matters for the
            // delivered/deliveredAll computation.
            try {
              const peerDevs = await this.peerDevices.getPeerDevices(originalPeer);
              const envelopeToDevice = new Map<string, string>();
              for (const dev of peerDevs) {
                envelopeToDevice.set(`sibling:${inner.id}:${dev.deviceId}`, dev.deviceId);
              }
              this.status.trackOutbound({
                messageId: inner.id,
                peerUserId: originalPeer,
                envelopeToDevice,
              });
            } catch {
              // peerDevices lookup is best-effort. If the network is
              // unreachable we fall back to the pre-fix behavior
              // (no status tracking for this row); no worse than
              // shipping without the fix.
            }
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
            // statuses forward the same way the originating device did,
            // AND so unread counts in listConversations() converge across
            // own devices.
            this.status.onRead({ peerUserId: originalPeer, upToId: inner.upToId });
            await this.bumpReadWatermark(originalPeer, inner.upToId);

            // A sibling device of ours already shipped this watermark to
            // peer on the user's behalf. Bump lastReadSent so this
            // device's future markRead(...) calls for this (or earlier)
            // watermark skip the redundant wire send — preventing
            // siblings from each independently re-shipping the same
            // read receipt on their own page reloads.
            const inboundMsg = await this.messages.get(inner.upToId);
            if (inboundMsg) {
              await this.setLastReadSent(originalPeer, inboundMsg.sentAt);
            }
            return;
          }
          case "chatDeleteSelf": {
            // A sibling device of ours triggered "delete this chat on
            // every device of mine." Wipe local + bump the watermark
            // so we don't accidentally honor a stale delete-all from
            // the peer after the user recreates the conversation.
            await this.messages.deleteForPeer(inner.peerUserId);
            await this.conversations.delete(inner.peerUserId);
            await this.messages.setDeleteWatermark(inner.peerUserId, inner.clientSentAt);
            await this.emitConversationsChanged([inner.peerUserId]);
            this.dispatch("conversationDeletedBySelf", { peerUserId: inner.peerUserId, scope: "me" });
            return;
          }
          case "chatDeleteAll": {
            // A sibling device of ours sent the delete-for-everyone
            // event to `originalPeer`. Our local view must match —
            // wipe + bump watermark.
            await this.messages.deleteForPeer(originalPeer);
            await this.conversations.delete(originalPeer);
            await this.messages.setDeleteWatermark(originalPeer, inner.clientSentAt);
            await this.emitConversationsChanged([originalPeer]);
            this.dispatch("conversationDeletedBySelf", { peerUserId: originalPeer, scope: "everyone" });
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
      // Always durable + notifyPush:false. SelfEcho is sibling-device
      // state sync, never something the user needs to be woken for —
      // notifyPush:false handles the no-push concern. Durable delivery
      // ensures offline siblings drain the event on next reconnect, so
      // their local history converges with the device that initiated
      // the action. Previously (0.13.5) we made selfEcho of `read`
      // events ephemeral to avoid pushing siblings, but that caused
      // the same offline-sibling-misses-the-event bug as the peer
      // path: notifyPush is the right tool for "don't push", not
      // ephemeral.
      await this.sendContent(this.selfUserId, echo, { ephemeral: false, notifyPush: false });
    } catch {
      // ignore — peer-side delivery already succeeded; sync convergence
      // gets a second chance on the next send.
    }
  }

  private async sendContent(
    peerUserId: string,
    event: ContentEvent,
    opts: { ephemeral: boolean; notifyPush?: boolean },
  ): Promise<void> {
    try {
      await this.sendContentInner(peerUserId, event, opts);
    } catch (err) {
      // Translate any low-level throw (HttpError, fetch TypeError, crypto
      // Error) into a typed ChatError so public API callers only need to
      // switch on `ChatError.code`. Ephemerals (typing) silently swallow
      // upstream via .catch(() => {}), so the wrap is harmless there.
      throw toChatError(err);
    }
  }

  /**
   * Best-effort delivery of a single ciphertext to a peer device that
   * `SessionManager`'s background discovery just learned about. The
   * original send already completed (via `sendContentInner`) to the
   * devices the bundleCache knew about; this catches up the same
   * plaintext to the newly-discovered device.
   *
   * Status tracker is NOT updated — the user-visible "delivered" state
   * is already driven by the original target set. The catch-up envelope
   * is silent on the SDK API surface: if it lands, the recipient device
   * gets the message; if it doesn't, future sends fanout to that device
   * naturally (bundleCache has been refreshed by the discovery flow).
   *
   * Drops if the WS isn't open. No outbox queueing — the catch-up is an
   * optimization on top of the existing protocol, not a delivery
   * guarantee. The "real" guarantee is the next normal send.
   */
  private shipCatchUpEnvelope(env: import("./sessions.js").CatchUpEnvelope): void {
    if (this.ws.getState() !== "open") return;
    const target: ChatSendTarget = {
      deviceId: env.peerDeviceId,
      ciphertext: env.ciphertext,
      envelopeUuid: generateUUID(),
    };
    try {
      this.ws.sendChat({
        toUserId: env.peerUserId,
        msgType: env.msgType,
        targets: [target],
      });
    } catch {
      // best-effort
    }
  }

  private async sendContentInner(
    peerUserId: string,
    event: ContentEvent,
    opts: { ephemeral: boolean; notifyPush?: boolean },
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
      // Ephemerals (typing) silently fail — re-delivering a stale "X is
      // typing" hours later is worse than dropping it. Persistent events
      // throw so the host app can surface a "user can't be reached" UX
      // (gated on `err.code === "peer_unreachable"`).
      if (opts.ephemeral) return;
      throw new ChatError(
        "peer_unreachable",
        `peer ${peerUserId} has no chat-registered devices (claim_all returned empty)`,
      );
    }
    // Build {target, msgType} entries so we can group by msgType below.
    // The wire protocol carries msgType at the frame level (not per-
    // target), but per-device encryption produces a MIX of msgTypes:
    // existing-session devices get msgType="normal", first-contact
    // devices get msgType="prekey" (from a freshly-claimed OTK). If we
    // sent one frame with a single msgType across all targets, the
    // recipients whose actual ciphertext doesn't match that msgType
    // would silently fail to decrypt — the bytes for prekey vs normal
    // are structurally different. Solution: bucket targets by their
    // actual msgType and emit one chatSend frame per bucket.
    const entries = encrypted.map((e) => ({
      target: {
        deviceId: e.peerDeviceId,
        ciphertext: e.ciphertext,
        envelopeUuid: generateUUID(),
      } satisfies ChatSendTarget,
      msgType: e.msgType,
    }));
    const targets: ChatSendTarget[] = entries.map((e) => e.target);

    // For non-typing/non-read events, register with the status tracker
    // so chatSendResult and inbound `received`/`read` can update status.
    if (event.type === "text" || event.type === "edit" || event.type === "delete") {
      const map = new Map<string, string>();
      for (const t of targets) map.set(t.envelopeUuid, t.deviceId);
      this.status.trackOutbound({ messageId: event.id, peerUserId, envelopeToDevice: map });
    }

    // Group by msgType → one frame per bucket. Typical fanout produces
    // either ALL normal (steady-state) or 1 prekey + N normal (when a
    // peer just added a new device); the cost of the second frame is
    // negligible compared to the silent-decrypt-fail it prevents.
    const byMsgType = new Map<"prekey" | "normal", ChatSendTarget[]>();
    for (const e of entries) {
      const arr = byMsgType.get(e.msgType) ?? [];
      arr.push(e.target);
      byMsgType.set(e.msgType, arr);
    }
    const frames = Array.from(byMsgType.entries()).map(([msgType, t]) => ({
      toUserId: peerUserId,
      ephemeral: opts.ephemeral || undefined,
      // Wire-emit notifyPush only when explicitly false. Absent field
      // means "legacy default = push allowed" which keeps older nodes
      // (that don't parse the field) compatible with new SDKs.
      notifyPush: opts.notifyPush === false ? false : undefined,
      msgType,
      targets: t,
    }));

    if (opts.ephemeral) {
      // Typing & other ephemerals are fire-and-forget — if the WS isn't
      // open, drop silently. Retrying typing later would deliver a
      // confusing "X is typing" hours after the fact.
      if (this.ws.getState() === "open") {
        for (const f of frames) {
          try {
            this.ws.sendChat(f);
          } catch {
            // ignore
          }
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
          for (const f of frames) {
            this.ws.sendChat(f);
          }
          // Synthesize "stored" so the outbox treats this as a successful
          // attempt and removes the entry. The real per-target outcome
          // arrives separately as a chatSendResult frame (consumed by
          // StatusTracker — but only relevant for the error-downgrade
          // path now, since we pre-promote below).
          for (const t of targets) outcomes.set(t.envelopeUuid, "stored");
          // 0.13.3: promote StatusTracker to "sent" RIGHT NOW, without
          // waiting for the node's chatSendResult to come back. The
          // node's wait-for-ack flow can delay chatSendResult by ~2s
          // when the recipient is offline, producing a "sent" UI
          // indicator that's invisibly behind. The optimistic
          // promotion here matches user expectation. If the node
          // later reports per-target errors, onSendResult downgrades
          // to "failed".
          if (event.type === "text" || event.type === "edit" || event.type === "delete") {
            for (const t of targets) {
              this.status.onSendResult(t.envelopeUuid, "stored");
            }
          }
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
      // ephemeral:false (durable) + notifyPush:false (silent). Same
      // reasoning as markRead: the receipt fans out to all of the
      // sender's devices; any device offline at flush time would
      // permanently miss the ✓✓ if the wire send was ephemeral, and
      // the sender's UI would show ✓ forever on that device. Push is
      // still suppressed via notifyPush so durable delivery doesn't
      // wake the sender.
      this.sendContent(peerUserId, newReceived(ids), { ephemeral: false, notifyPush: false }).catch(() => {});
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
export { MMKVKVStore, type MMKVLike } from "./store/mmkv-adapter.js";
export type { KVStore } from "./store/interface.js";
export type { StoredMessage };
export type { MessageStatus } from "./status.js";
