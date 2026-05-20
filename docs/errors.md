# Errors reference

Every public SDK method that touches the wire (`sendText`,
`editMessage`, `deleteMessage`, `markRead`, `retrySend`,
`getKnownPeerDevices`, `deleteConversationForEveryone`, etc.) throws a
typed `ChatError`. Lower-level errors (`HttpError`, `TypeError` from
`fetch`, Olm decrypt exceptions) are wrapped at the public-API
boundary so callers only ever see `ChatError`.

```ts
import { ChatError } from "@dtelecom/secure-chat-client";

try {
  await chat.sendText(peerId, text);
} catch (err) {
  if (err instanceof ChatError) {
    switch (err.code) {
      case "peer_unreachable":
      case "edit_window_expired":
      // ...
    }
  }
  throw err; // non-ChatError = bug
}
```

The `code` field is the stable identifier — branch on it, not on
`message`. `status` is set when the error originated from an HTTP
response. `cause` holds the wrapped lower-level error if any (useful
for debugging; don't show to the user).

---

## `peer_unreachable`

`claim_all` returned no devices for the peer.

**Common causes:**
- The peer has never signed in to chat (no key bundle uploaded).
- The peer signed out and called `wipeUserData` on every device.
- The peer has blocked the caller server-side. The chat backend
  silently returns an empty device list for blocked-by relationships
  — indistinguishable from "no devices" by design.

**Thrown from:** `sendText`, `editMessage`, `deleteMessage`,
`markRead`, `retrySend`, `deleteConversationForEveryone`.

**Recovery:** show a "this user can't be reached" UX. For
`deleteConversationForEveryone` specifically, the local wipe still
happens before the throw — only the peer-side wipe didn't fire.

---

## `auth_expired`

Tenant backend returned 401 or 403 on a `/keys/*` or `/envelopes/*`
HTTP call.

**Common causes:** the host's session token expired (e.g., Privy
access token refresh failed), or the user's account was disabled.

**Carries:** `err.status` = 401 or 403.

**Recovery:** prompt re-login via the host app's auth flow. After
the user re-authenticates, the next SDK call will resolve a fresh
bearer via the `fetchHttpBearer` callback.

---

## `offline`

The underlying `fetch` threw (no network reachable, DNS failure,
TLS handshake failure, etc.).

**Recovery:** show offline UX. The SDK's outbox will automatically
retry outbound messages on the next WebSocket reconnect. Inbound
will resume via `drainPending` when the WS comes back.

---

## `rate_limited`

Tenant backend returned 429.

**Carries:** `err.status === 429`.

**Recovery:** back off. The SDK does not auto-retry on 429 (no
universal backoff strategy fits all consumers). Show "slow down"
UX and let the user re-try.

---

## `server_error`

Tenant backend returned 5xx.

**Carries:** `err.status` = the 5xx code.

**Recovery:** transient — usually safe to retry after a short delay.
Show a "server hiccup" indicator.

---

## `edit_window_expired` *(new in 0.12.0)*

`editMessage` called on a message older than `EDIT_WINDOW_MS`
(default 24h).

**Thrown from:** `editMessage` only.

**Why:** the SDK enforces a 24h edit window matching WhatsApp /
Telegram / Signal conventions. Receivers re-enforce the same window
so a clock-skewed sender can't sneak past.

**Recovery:** disable the "edit" UI affordance after the window
passes:

```ts
const canEdit = msg.senderUserId === chat.currentUserId &&
                msg.deletedAt === null &&
                Date.now() - msg.sentAt < EDIT_WINDOW_MS;
```

The user can still `deleteMessage` (no time limit on delete).

---

## `not_found` *(new in 0.12.0)*

`editMessage` or `deleteMessage` called with a `targetId` that isn't
in the local store.

**Thrown from:** `editMessage`, `deleteMessage`.

**Common cause:** UI bug (passing the wrong id), or a multi-tab race
where the user deleted from another tab between render and click.

**Recovery:** refresh the conversation view from
`chat.getHistory(peerUserId)`.

---

## `not_authorized` *(new in 0.12.0)*

`editMessage` or `deleteMessage` called on a message you didn't
author (the stored `senderUserId` isn't `chat.currentUserId`).

**Thrown from:** `editMessage`, `deleteMessage`.

**Common cause:** UI bug — the edit/delete affordance should only be
shown on messages where `senderUserId === chat.currentUserId`. The
receiver-side check also enforces this (defense-in-depth: even a
patched SDK or raw transport can't forge a successful edit).

**Recovery:** fix the UI gating. Don't show edit/delete on peer
messages.

---

## `internal`

SDK-side bug, crypto failure (corrupt Olm state, unexpected null,
malformed JSON in storage), or a code path that shouldn't be
reachable.

**Carries:** `err.cause` set to the original error when available.

**Recovery:** safe to surface as a generic "Something went wrong"
toast. The code path needs investigation — capture a sentry/log
event with `err.cause`.

---

## What does NOT throw

- `chat.on(event, handler)` — never throws; returns an unsubscribe
  function.
- `chat.listConversations()` / `chat.getHistory()` — read-only,
  never throws (returns empty on missing data).
- `chat.setTyping(...)` — fire-and-forget; failures are silent (a
  stale "X is typing" hours later is worse than dropping it).
- `chat.disconnect()` — best-effort cleanup; never throws.
- `chat.markPeerDeviceVerified(...)` — local KV write; never throws.

## Quick reference

| Code | When | Carries | Recovery |
|---|---|---|---|
| `peer_unreachable` | Peer has no chat-registered devices | — | "Can't be reached" UX |
| `auth_expired` | Backend returned 401/403 | `status` | Prompt re-login |
| `offline` | Network unreachable | `cause` (fetch err) | Offline UX; auto-retry on reconnect |
| `rate_limited` | Backend returned 429 | `status: 429` | Back off |
| `server_error` | Backend returned 5xx | `status` | Retry after delay |
| `edit_window_expired` | Edit > 24h after send | — | Disable affordance |
| `not_found` | targetId not in store | — | Refresh history |
| `not_authorized` | Edit/delete peer's message | — | Fix UI gating |
| `internal` | SDK bug / crypto failure | `cause` | Log + generic toast |
