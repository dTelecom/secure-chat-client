# @dtelecom/secure-chat-client

TypeScript SDK for end-to-end encrypted 1:1 chat over the dTelecom mesh. Olm via vodozemac, fanout multi-device, multi-device sync (Signal-style), self-echo, at-least-once delivery with client-device ACK, content-protocol forward compat.

## Status

**v0.12.0** — current. Requires dtelecom-node v1.1+.

What's new across recent versions:

- **0.12.0** — 24h edit window (`EDIT_WINDOW_MS`), multi-device `deleteConversationForMe`, `deleteConversationForEveryone` with one-shot watermark replay-guard, new `conversationDeletedBySelf` / `conversationDeletedByPeer` events. See [`CHANGELOG.md`](CHANGELOG.md).
- **0.11.0** — at-least-once delivery via client-device `chatEnvelopeAck`. Sender retries + post-webhook republish. Pre-decrypt envelope dedup (persisted LRU). Fixes the optimistic-StatusLive race. **Requires node v1.1+.**
- **0.10.0** — fixed mixed-msgType fanout (delivery to existing-session devices was silently failing when a peer added a new device). Background discovery + catch-up envelopes.
- **0.9.0** — per-user scoped storage. `selfUserId` now required at construction time. `wipeUserData` static helper.

For per-version migration steps see [`docs/migration.md`](docs/migration.md).

163/163 unit + ~30 integration smokes against the deployed dTelecom mesh on Solana devnet. Browser (Chrome/Edge/Safari/Firefox via Vitest browser-mode) and Node (tsx + Vitest) both validated. React Native: works on RN 0.84+ / Hermes V1 (WebAssembly support).

## Install

```sh
npm install @dtelecom/secure-chat-client
```

`@dtelecom/vodozemac-wasm` is a peer-of-this-package dep (resolved transitively).

## Quick start

```ts
import { DTelecomSecureChat, EDIT_WINDOW_MS } from "@dtelecom/secure-chat-client";

const chat = await DTelecomSecureChat.connect({
  // Full endpoint prefix — host + path. The SDK appends bare relative
  // paths under it (e.g. /token, /keys/upload, /envelopes/pending).
  apiBaseURL: "https://your-tenant-backend.example/api/secure-chat",
  // REQUIRED since 0.9.0. The signed-in user's id. The SDK scopes ALL
  // persisted state under `u/<userId>/` so two users on the same
  // browser/device are physically isolated.
  selfUserId: "did:privy:abc123...",
  fetchChatToken: async (deviceId) => {
    // Call your tenant backend; it should mint a chat-token JWT
    // signed with the tenant wallet (Ed25519 via Solana registry).
    // The returned chatToken is used ONLY on the WebSocket to the
    // dtelecom node — it doesn't auth the HTTP API (see fetchHttpBearer).
    const r = await fetch("/api/secure-chat/token", {
      method: "POST",
      headers: { Authorization: `Bearer ${await getPrivyAccessToken()}` },
      body: JSON.stringify({ deviceId }),
    });
    return r.json(); // { chatToken, chatNodeWsUrl, expiresAt }
  },
  // The bearer for every HTTP request to the tenant backend (`/keys/*`,
  // `/envelopes/*`). For dmeet this is the Privy access token — exactly
  // what every other `/api/*` route already accepts. Called per-request;
  // let the host's session library handle caching/refresh.
  fetchHttpBearer: async () => getPrivyAccessToken(),
  // Optional. The current user-block set, sourced from your host backend
  // (e.g. dmeet's /api/users/block-user UX). Inbound messages from these
  // peers arriving over a previously-established Olm session are dropped
  // BEFORE they surface to the UI. Push updates via chat.setBlockedUserIds.
  initialBlockedUserIds: ["bad-user-1", "bad-user-2"],
});

// ── Events (see docs/events.md for full reference) ────────────────────
chat.on("message", (e) => console.log(e.peerUserId, "→", e.message.text));
chat.on("messageEdited", (e) => /* ... */);
chat.on("messageDeleted", (e) => /* ... */);
chat.on("statusChange", (e) => /* pending → sent → delivered → deliveredAll → read | failed */);
chat.on("typing", (e) => /* started / stopped */);
chat.on("readReceipt", (e) => /* upTo a given message id */);
chat.on("peerNewDevice", (e) => /* TOFU UI */);
chat.on("conversationsChanged", () => /* re-render the chat list */);
chat.on("conversationDeletedBySelf", (e) => /* you or a sibling deleted */);
chat.on("conversationDeletedByPeer", (e) => /* peer deleted-for-everyone */);
chat.on("connectionStateChange", (e) => /* "connecting" | "open" | "reconnecting" | "closed" */);
chat.on("messageSendFailed", (e) => /* outbox gave up */);
chat.on("tabConflict", (e) => /* "primary" | "secondary" — show "open elsewhere" overlay when secondary */);

// ── Messaging ─────────────────────────────────────────────────────────
const messageId = await chat.sendText("bob-user-id", "hi bob");

// Edit within the 24h window (EDIT_WINDOW_MS). Throws
// ChatError("edit_window_expired") if past, ChatError("not_authorized")
// if not your message, ChatError("not_found") if unknown id.
await chat.editMessage("bob-user-id", messageId, "edited");

// Tombstone a message you sent. No time limit.
await chat.deleteMessage("bob-user-id", messageId);

await chat.markRead("bob-user-id", messageId);
chat.setTyping("bob-user-id", true);

// Re-send a message that's in status "failed".
await chat.retrySend(messageId);

// ── Chat list ─────────────────────────────────────────────────────────
// Sorted most-recent-first. Each entry has lastMessageAt + a snapshot of
// the latest message (including editedAt / deletedAt — render badges) +
// status (for your own messages) + unreadCount.
const convs = await chat.listConversations();
const totalUnread = await chat.getTotalUnreadCount();
const history = await chat.getHistory("bob-user-id", { limit: 50 });

// ── Deleting a chat (new in 0.12.0) ───────────────────────────────────
// Delete on YOUR side (every device of yours via self-echo). Peer keeps
// the thread.
await chat.deleteConversationForMe("bob-user-id");

// Delete on BOTH sides — peer's UI fires conversationDeletedByPeer and
// their local history is wiped. One-shot: if either side later sends
// fresh text, the conversation re-creates; a stale delete-all replayed
// from the at-least-once layer cannot wipe the new conversation.
await chat.deleteConversationForEveryone("bob-user-id");

// ── Preferences + verification ────────────────────────────────────────
await chat.setReadReceiptsEnabled(false);
await chat.markPeerDeviceVerified("bob", "bob-phone", true);
const fingerprint = await chat.getPeerDeviceFingerprint("bob", "bob-phone");

// Push the host's current block list whenever it changes.
await chat.setBlockedUserIds(["bad-user-1"]);

// ── Sign-out cleanup ──────────────────────────────────────────────────
// Drops every key under this user's scope. Run on sign-out so the next
// user on the same browser/device starts fresh.
async function signOut() {
  const userId = chat.currentUserId;
  await chat.disconnect();
  if (userId) await DTelecomSecureChat.wipeUserData(store, userId);
}
```

## Frontend docs

Quick start above is the 30-second tour. For deeper integration:

- **[docs/events.md](docs/events.md)** — all 13 events: payload shape, when they fire, typical UI reaction
- **[docs/errors.md](docs/errors.md)** — every `ChatError.code` with cause + recovery hint
- **[docs/ui-recipes.md](docs/ui-recipes.md)** — concrete patterns for chat list, edit/delete affordances, deletion menu, typing, status indicators, multi-tab overlay, sign-out
- **[docs/multi-device.md](docs/multi-device.md)** — self-echo, sibling sync, tab coordination, scoped storage, background discovery
- **[docs/delivery-semantics.md](docs/delivery-semantics.md)** — what `live` / `stored` mean, at-least-once + dedup, retry budget
- **[docs/migration.md](docs/migration.md)** — per-version upgrade notes (0.1 → 0.12)
- **[CHANGELOG.md](CHANGELOG.md)** — full version history

## Architecture

The SDK does NOT bundle Solana RPC or STUN. Node discovery is delegated to the tenant backend: `POST /api/chat/token` returns a chat-token JWT plus the closest dtelecom node's WebSocket URL (`chatNodeWsUrl`), computed server-side via `@dtelecom/server-sdk-js`. This keeps the browser bundle small and reuses the same node-selection logic as room WebRTC.

Wire contract: `chat-wire-contract.md` (in the dTelecom monorepo).
Architecture: `secure-chat-plan.md`.

## Tests

### Unit + browser

```sh
npm test                  # 163 Node-mode tests
npm run test:browser      # 2 browser tests in real Chromium (Playwright)
```

### Wallet (no network)

```sh
cp .env.test.example .env.test    # fill in the test wallet vars
npm run smoke:wallet
```

Confirms LK_API_KEY/LK_API_SECRET sign + verify a chat-token JWT locally.

### Stage D integration matrix (real mesh)

Run all scenarios with `npm run smoke:all`. Smokes that exercise the offline-fallback path (`offline-fallback`, `push-gating`, `crash-recovery`, `delivery-ack-tab-close`, `delivery-ack-post-webhook`, `chat-delete-recreate`) require the deployed nodes to POST back to the mock's webhook endpoint, so the mock must be started with a public tunnel: `cd ../secure-chat-mock && TUNNEL=1 npm start` (uses `cloudflared` quick tunnels — no auth needed, install via `brew install cloudflared`).

| Smoke | What it covers |
|---|---|
| **Delivery semantics (0.11.0+)** | |
| `smoke:delivery-ack` (dedup) | Same envelopeUuid shipped twice → `message` fires once; Olm session stays healthy |
| `smoke:delivery-ack-tab-close` | Recipient WS closes before processing → sender sees `stored`, not optimistic `live` |
| `smoke:delivery-ack-reconnect-race` | Recipient reconnects mid-flow → retry catches it, no webhook |
| `smoke:delivery-ack-post-webhook` | Recipient reconnects after webhook → post-webhook publish delivers; dedup keeps it singular |
| **Chat housekeeping (0.12.0)** | |
| `smoke:edit-window` | 24h limit enforced sender-side AND receiver-side |
| `smoke:chat-delete-self` | `deleteConversationForMe` wipes locally + on siblings; peer unaffected |
| `smoke:chat-delete-all` | `deleteConversationForEveryone` wipes both sides; peer fires `conversationDeletedByPeer` |
| `smoke:chat-delete-recreate` | Watermark guard: stale delete-all replayed after re-engagement is dropped |
| **Multi-device** | |
| `smoke:multidevice-online-offline` | 17-assertion online/offline matrix across 3 sibling devices |
| `smoke:multi-device-sender` | Alice with 2 devices; bidirectional fanout; self-echo |
| `smoke:self-echo` | text/edit/delete/read all sync to other own devices |
| `smoke:peer-new-device` | `peerNewDevice` fires once on new bob device; subsequent fanout includes it |
| **Transport + auth** | |
| `smoke:auth` | Chat-token JWT happy path + reject expired / wrong typ / unregistered signer |
| `smoke:transport` | Same-node alice→bob round-trip, low-level WS + `chatSendResult` + `chatEnvelopeAck` |
| `smoke:cross-node` | alice + bob on distinct nodes; gossipsub-routed delivery + ack round-trip |
| `smoke:fanout` | bob with 3 devices; alice's status walks `sent → delivered → deliveredAll` |
| `smoke:offline-fallback` | bob offline → mock stores envelope → bob reconnects → decrypts |
| `smoke:push-gating` | push=false when sibling device live; push=true when all offline |
| `smoke:ephemeral` | typing event drops on offline-fallback path (no mock POST) |
| `smoke:edit-delete-authz` | edits/deletes from non-author dropped (sender-side AND receiver-side) |
| `smoke:read-typing` | read watermark, typing throttle, auto-stop |
| `smoke:fwd-compat` | unknown content type / `v: 2` silently dropped; v1 keeps flowing |
| `smoke:crash-recovery` | mid-pull crash → reconnect → idempotent dedupe; `message` fires once |
| `smoke:node-failure` | client-side WS drop → auto-reconnect → resume send/receive |
| `smoke:idle` | 50 idle WS connections produce zero offline-fallback / pushes |
| `smoke:history-reload` | `getHistory` survives disconnect+reconnect with same store; fresh = empty |
| `smoke:otk-exhaustion` | OTK pool drains → fallback prekey works; auto-topup refills on reconnect |
| `smoke:read-receipts-gating` | `setReadReceiptsEnabled(false)` suppresses outbound `read`; re-enable restores |

To skip Solana discovery and point at a specific node (local dev or a known test node), set `CHAT_NODE_WS_URL_OVERRIDE=wss://node.example` in the **mock's** environment before starting it.

## License

Apache-2.0
