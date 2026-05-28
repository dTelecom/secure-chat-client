# Changelog

All notable changes to `@dtelecom/secure-chat-client`. Format adapted
from [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The SDK loosely follows semver: minor bumps may add public API surface
and (rarely, when explicitly noted) tighten existing contracts; patch
bumps are bug fixes and doc-only changes.

Node compatibility is called out per release where it matters. The
SDK and the dtelecom-node ship in lockstep under dTelecom's own
control — there is no broad-deployment compat negotiation.

---

## [0.13.5] — 2026-05-28

### Changed

- **Push notifications now fire ONLY for `text` events**. Edits,
  deletes, conversation wipes (chatDeleteAll), read receipts (markRead),
  delivery acks (received), typing indicators, and selfEcho fanout no
  longer wake the recipient via push, even when the peer is offline.
  Durability is preserved for the events that need it (edit/delete/
  chatDeleteAll still go through the durable webhook path — they just
  set `push: false` so the backend skips the notification).

  Implementation: new `notifyPush?: boolean` wire field on
  `ChatSendFrame`. The SDK sets `notifyPush: false` on all non-text
  sends. The node ANDs this hint with its presence-based push
  computation when constructing the webhook body's `push` field. The
  backend is unchanged — it just sees `push: false` more often and
  skips `FireChatPushIfNeeded` for those envelopes.

### Compatibility

- **Requires node ≥ 2026-05-28** (`livekit/pkg/chat` commit `a193b45d`)
  for the suppression to take effect. Older nodes silently ignore the
  unknown `notifyPush` field and continue pushing for all event types
  (no breakage, just no effect).
- Older SDKs (< 0.13.5) keep working against new nodes — the absent
  `notifyPush` field maps to "legacy default = push allowed", preserving
  prior behavior.
- Backend (`dmeet-backend`) requires no changes.

---

## [0.13.4] — 2026-05-28

### Fixed

- **Message status stuck at "pending" forever**. `sendText` was awaiting
  `sendContent` BEFORE calling `messages.put({status:"pending"})`, so the
  Option-A optimistic-promotion path (added in 0.13.3) fired its
  StatusTracker listener with the row not yet in the store — the
  listener silently skipped its persist (the `if (msg && ...)` guard),
  then `sendText`'s own `put` locked the row at "pending" for the
  lifetime of the install. The wire send actually succeeded; only the
  persisted status was wrong, which meant the UI showed `⏳` instead of
  `✓` after page reload. Fix: persist first, then send. On `sendContent`
  throw, the row is downgraded to "failed" (with a `statusChange`
  event) before the error propagates, so `retrySend` can pick it up.

- **Read receipts and delivery acks triggering offline push notifications**.
  `markRead` and `flushReceivedBatch` were both `ephemeral: false`, so
  when the original sender was offline the `read` / `received` envelopes
  went through the webhook fallback and fired `FireChatPushIfNeeded`.
  Symptom: opening any chat with an offline peer woke them up via push
  ("You have a new message"), and every page reload re-fired the same
  push because the FE's `lastMarkedReadRef` resets on mount. The backend
  has no way to filter by content type — the ciphertext is encrypted —
  so the SDK has to mark these as ephemeral. Fix: `markRead`,
  `flushReceivedBatch`, and the `selfEcho` fanout of `read` events all
  use `ephemeral: true`. With the ephemeral fast-path on the node
  (livekit/pkg/chat dispatch, 2026-05-26), this means one publish
  attempt, no retry, no webhook, no push. Lost wire delivery is
  self-healing: the next `markRead` / received batch re-establishes the
  sender's UI.

---

## [0.13.3] — 2026-05-20

### Fixed

- **Slow "sent" indicator when recipient is offline**. The sender's
  per-message status was bumped from `"pending"` → `"sent"` only when
  the node's `chatSendResult` frame arrived. The node's at-least-once
  flow waits for a client-device ack with a 2s deadline, so for an
  offline recipient the sender's UI showed ⏳ for ~2 seconds before
  flipping to ✓. The status is now promoted **immediately** when
  `ws.sendChat` returns successfully inside the outbox attempt — no
  wait. Restores the fast-feedback UX that existed pre-0.11.0,
  without rolling back the at-least-once delivery guarantees.

  The honest meaning of `"sent"` shifts slightly: it now means
  "bytes left this SDK without throwing" rather than "node confirmed
  acceptance." In practice these are nearly identical — a successful
  `ws.send()` call has written to the TCP socket buffer. The later
  `chatSendResult` still arrives (10-100ms online, ~2s offline) and
  is used to detect and propagate genuine server-side failures (see
  next item).

### Added

- **`messageSendFailed` with `reason: "server_rejected"`**. When the
  node returns `chatSendResult.status: "error"` for EVERY per-target
  envelope of a message (none of the recipient's devices accepted
  the send), the sender's status downgrades from `"sent"` →
  `"failed"` and `messageSendFailed` fires with the new reason. The
  downgrade is gated on `status` being one of `"pending"` /
  `"sent"` — if the message already moved further along the ladder
  (`"delivered"` / `"read"`), a late error frame for one stale
  target is ignored. Partial errors with at least one successful
  target stay at `"sent"`.

  The existing `reason: "max_attempts_exceeded"` (outbox gave up
  retrying) is unchanged. UI consumers that branch on the reason
  field should add a case for `"server_rejected"`; consumers that
  treat any `messageSendFailed` event the same way need no change.

### Compatibility

SDK-only, no node or wire-protocol change.

`MessageSendFailedEvt.reason` adds a new literal-union variant. This
is type-additive: existing exhaustive `switch (reason)` consumers
will warn on the new variant but still function (default cases keep
working). No breaking change for consumers using `instanceof
ChatError` patterns.

---

## [0.13.2] — 2026-05-20

### Fixed

- **Permanently undecryptable envelopes stuck in `/envelopes/pending`
  forever**. When the recipient's IndexedDB / scoped KV is wiped
  (manual clear, profile reset, OS storage eviction), the local Olm
  Account is gone — but the backend still has OTKs the sender will
  claim. The sender's prekey-message references an OTK whose private
  key no longer exists on the recipient. Decrypt fails with
  vodozemac's "unknown one-time key" error. Pre-0.13.2, those
  envelopes stayed in the backend's pending queue forever; every
  reconnect drained them, failed to decrypt, and produced log spam.

  `drainPending` now distinguishes between terminal and transient
  decrypt failures:
    - Match on the substring "unknown one-time key" (case-insensitive)
      → the envelope is permanently unrecoverable on this device.
      HTTP-ack to clear from the backend queue. The message is lost
      (no key material exists to decrypt it), but the queue moves
      forward.
    - Any other error → keep the existing "leave on queue, retry next
      reconnect" behavior. Those can recover via the SDK's existing
      decrypt-failure recovery path (forgetPeerDevice + refresh +
      retry).

  Log line emitted (visible at `warn` level and above, or in the
  ring buffer regardless of level):
  ```
  [sdk] delivery: envelope permanently undecryptable (unknown OTK), acking to clear queue
  ```

### Scope note

Only "unknown one-time key" is treated as terminal. Other
structurally-unrecoverable errors ("no session for normal-type
ciphertext", certain MAC failures) are still retried indefinitely
for now. If those start showing up in production logs at meaningful
rates, the same pattern can be extended — but each addition needs
its own analysis to avoid acking-away-recoverable envelopes.

---

## [0.13.1] — 2026-05-20

### Fixed

- **0.13.0 published with stale `dist/`** — `npm publish` packed an
  old compiled output from before the logging work landed, so the
  published tarball was missing `ConnectOptions.debug`,
  `getDiagnostics()`, and all the instrumentation. 0.13.1 has the
  correct compiled output. Added a `prepublishOnly` hook that runs
  `tsup` to prevent this from recurring.

### Source-level changes vs 0.13.0

None — same source as 0.13.0. This is purely a republish with the
correct compiled `dist/`. If you installed `^0.13.0` you have the
broken version; upgrade to `^0.13.1` to actually get the logging.

---

## [0.13.0] — 2026-05-20

### Added

- **Diagnostic logging**. New `ConnectOptions.debug` field accepts
  `"silent" | "error" | "warn" | "info" | "debug"`. Off by default.
  Can also be enabled at runtime without code change by setting
  `localStorage["@dtelecom/secure-chat-client:debug"] = "debug"` in
  the browser console and reloading. Critical paths now log:
  - `[http]` every HTTP call (method, path, status, response shape)
  - `[sessions]` bundleCache transitions, claim_all,
    forgetPeerDevice, empty-cache cooldown decisions
  - `[crypto]` decrypt attempts + outcomes, session bootstraps
  - `[dedup]` add/has/remove on `EnvelopeDedup`
  - `[delivery]` inbound envelope flow + ack decisions
  - `[discovery]` list_devices firings + new-device detection
  - `[sdk]` WebSocket state transitions

- **`chat.getDiagnostics(): ChatDiagnostics`**. Returns a snapshot of
  internal SDK state: bundleCache (per-peer device counts +
  cooldowns), peerDevicesCache, in-flight claim_all / discovery
  ops, envelopeDedup size, WS state, recent log events. Safe to
  dump into a bug report — no ciphertext, no key material, no
  plaintext message content.

- **Ring buffer of recent events** (always-on, 256-entry cap,
  bounded memory). Independent of console logging — every log call
  goes into the ring regardless of level. Surfaced via
  `getDiagnostics().recentEvents`.

### Changed

- `LogLevel` and `LogEvent` types exported from the package root
  for typed handling in FE code.

### Compatibility

SDK-only. No node, wire-protocol, or behavior change. Default state
(no `debug` option, no localStorage key) emits zero console output —
fully backward-compatible with 0.12.x.

---

## [0.12.1] — 2026-05-20

### Fixed

- **`peer_unreachable` after a decrypt failure**.
  `SessionManager.forgetPeerDevice` left the `bundleCache` as `[]` when
  the filter removed the only entry. `ensurePeerBundles` then returned
  `[]` from cache without re-claiming, so every subsequent send threw
  `peer_unreachable` until the SDK instance was reconstructed (full
  page reload). The fix DELETES the cache entry when the filter
  empties it, so the next send re-claims.

  Additionally, `ensurePeerBundles` now treats `cached.length === 0`
  as a soft miss with a 5-second cooldown — re-claims on the next
  send after the cooldown expires. Bounds load on a genuinely-empty
  peer (blocked, deleted account) while allowing transient empties
  to resolve in seconds rather than requiring an SDK rebuild.

- **Lost messages from envelope dedup poisoning**.
  `EnvelopeDedup.add()` ran BEFORE decrypt in `handleInboundCiphertext`.
  When decrypt or `dispatchInboundEvent` failed (e.g., Olm session
  corruption from the cache bug above), the catch path threw and left
  the uuid permanently marked as "seen" in the persisted dedup. Every
  subsequent sender-retry of the same envelope was dropped pre-decrypt
  → message never reached the peer's `message` event or the store.
  Survived across page reloads (dedup is persisted in scoped KV).

  Fix: new `EnvelopeDedup.remove()`. The receive path now wraps the
  decrypt+dispatch flow and rolls back the dedup entry on failure, so
  the at-least-once delivery layer (sender retries + post-webhook
  publish + `drainPending` on next reconnect) can retry the
  envelope. The pre-decrypt add still guards against concurrent
  processing of the same envelope (Olm replay protection).

- **`list_devices` spam during normal chat**.
  Root cause was the decrypt-failure recovery path
  (`peerDevices.invalidate + refresh`) firing one
  `GET /keys/list_devices` per failed envelope. Each failure was
  driven by the dedup-poisoning bug above. With the dedup fix the
  cascade stops — receivers can now decrypt and the recovery path
  fires once at most (transient Olm session resets), not per-message.

### Added

- `EnvelopeDedup.remove(uuid)` (internal). Used by the SDK to roll
  back a uuid when decrypt/dispatch fails; no host-app use.

### Compatibility

SDK-only. No node or wire-protocol change. Works against the same
dtelecom-node v1.1+ that 0.11/0.12 already require. Existing apps
can upgrade without coordination.

---

## [0.12.0] — 2026-05-20

### Added

- **24h edit window**: `editMessage` now throws
  `ChatError("edit_window_expired")` when called more than
  `EDIT_WINDOW_MS` (24h) past the original message's `sentAt`.
  Receivers re-enforce so a clock-skewed sender can't sneak past.
- `EDIT_WINDOW_MS` exported from the package root — apps can compare
  against their own UI deadlines (e.g. disable the "edit" affordance
  once the window passes).
- **Multi-device chat delete (for me)**: `deleteConversationForMe(peerUserId)`
  wipes local history + index row, advances a per-peer delete
  watermark, and self-echoes a new `chatDeleteSelf` content event to
  sibling devices of the same user so they wipe too. The peer is NOT
  signaled. Future inbound from peer re-creates the thread.
- **Delete for everyone**: `deleteConversationForEveryone(peerUserId)`
  also sends a `chatDeleteAll` content event to the peer's devices,
  whose SDKs wipe local + fire `conversationDeletedByPeer`.
- **One-shot watermark guard** on delete-all replay: receivers track a
  per-peer `chatDeleteWatermark` and silently drop `chatDeleteAll`
  events whose `clientSentAt` is ≤ the watermark. A deliberate
  re-engagement (inbound or outbound text after the prior delete)
  advances the watermark, so a stale delete-all replayed from the
  at-least-once layer cannot wipe a recreated conversation.
- Events: `conversationDeletedBySelf({ peerUserId, scope: "me" | "everyone" })`,
  `conversationDeletedByPeer({ peerUserId })`.
- Error codes: `edit_window_expired`, `not_found`, `not_authorized`.
- `editMessage` and `deleteMessage` now reject locally — with
  `not_found` if the message isn't in the store and `not_authorized`
  if the caller isn't the original sender. (Receivers already
  enforced this; sender-side fail-fast avoids burning OTKs.)
- JSDoc on `StoredMessage.editedAt` / `deletedAt` flagging them as UI
  badge signals.

### Deprecated

- `deleteConversation(peerUserId)` — use `deleteConversationForMe`
  (multi-device wipe) or `deleteConversationForEveryone` (also wipe
  peer's side). The old method only clears the device it's called on
  and leaves siblings out of sync. Will be removed in a future major.

### Compatibility

SDK-only release. New content events ride the existing forward-compat
rule (older clients drop unknown types silently) — a 0.11 client
paired with a 0.12 sender simply doesn't honor the new delete or
edit-window, which is degraded but not crashing.

---

## [0.11.0] — 2026-05-19

### Added

- **At-least-once delivery with client-device ACK**. The receiver SDK
  now sends a new `chatEnvelopeAck` WS frame after durably storing
  each inbound envelope. The node returns `chatSendResult.status =
  "live"` only on receipt of that ack — not on the optimistic
  "writeJSON returned nil" path that masked tab-close races and
  half-open WS reads. Same semantics for same-node and cross-node.
- **Envelope dedup** (`EnvelopeDedup`): persisted LRU keyed on
  `envelopeUuid`, capped at 1000 entries per scoped user. Required
  because the new at-least-once node retries the publish within
  `fallback_timeout` (every ~500ms × 4) and does one post-webhook
  publish — duplicates are expected and must be dropped *before*
  Olm decrypt, otherwise replay-rejection would trigger the heavy
  `forgetPeerDevice` recovery path and nuke the session.
- Pre-decrypt dedup hook in `handleInboundCiphertext`; ack-after-store
  ordering (the ack fires at the end of `dispatchInboundEvent`, after
  `messages.put` resolves).
- `WsClient.sendEnvelopeAck` low-level helper for raw-transport tests.

### Compatibility

**Requires dtelecom-node v1.1+** (livekit commit `380468a9`: chat
at-least-once delivery via client-device ACK). Against a v1.0 node
the SDK still works but the new ack frame is ignored and delivery
semantics revert to the older optimistic behavior — paired correctly,
the new behavior is end-to-end.

Wire contract bumped to v1.1 in `tasks/chat-wire-contract.md`. Design
doc: `tasks/chat-client-ack.md`.

---

## [0.10.0] — 2026-05-19

### Fixed

- **Mixed-msgType fanout bug**: when a peer added a new device, the
  next outbound message produced "normal" ciphertext for existing-
  session targets and "prekey" ciphertext for the new device. The
  prior SDK used `encrypted[0].msgType` for the whole frame, so half
  the recipients got a frame whose declared `msgType` didn't match
  their actual ciphertext — and silently failed to decrypt. The fix
  groups targets by their actual `msgType` and emits one
  `chatSend` frame per group.

### Added

- **Background discovery + catch-up envelopes**: every send to a peer
  kicks off a low-cost `list_devices` poll in the background; when a
  newly-registered peer device appears, the SDK refreshes the
  bundleCache and ships catch-up envelopes for in-flight plaintexts
  so the new device receives without waiting for it to send first.
- `ConnectOptions.backgroundDiscovery` (default true) and
  `backgroundDiscoveryFloorMs` (default 30s) — rate-limits the
  list_devices polling.

### Compatibility

Runtime-only — no wire contract change.

---

## [0.9.0] — 2026-05-19

### Added

- **Per-user scoped local storage** (`ScopedKVStore`) — all persisted
  SDK state lives under a `u/<userId>/` prefix, isolated by the
  authenticated user. Sign-out → sign-in as a different user on the
  same browser/device no longer leaks Olm sessions, message history,
  conversation index, or block list across accounts.
- `DTelecomSecureChat.wipeUserData(store, userId)` — drop every key
  under a user's scope, for explicit sign-out hygiene.
- `migrateLegacyKeys` runs at bootstrap to move pre-0.9 unscoped keys
  into the scope of the connecting user (one-shot, idempotent).

### Changed

- **`selfUserId` is now a required `ConnectOptions` field**. Previously
  the SDK parsed it from the chat token's `sub` claim during the JWT
  exchange; making it explicit avoids a window where storage could be
  written under the wrong scope. Construction-time scope guarantees
  correctness from the first write.

### Compatibility

**Breaking** on the API surface (`selfUserId` required). No wire change.

---

## [0.8.1] — 2026-05-18

### Added

- `Conversation.lastMessage.status` exposed in `listConversations()` so
  chat-list rows can render delivery-state indicators (e.g. ✓ / ✓✓ /
  read) without a second store lookup per row.

---

## [0.8.0] — 2026-05-18

### Added

- **React Native support** via the `#vodozemac` subpath import. Node-
  flavored vodozemac (`@dtelecom/vodozemac-rn`) resolves automatically
  when bundled by Metro; the WASM build keeps shipping in browsers.
- New peer dep: `@dtelecom/vodozemac-rn` (host-installed under RN; not
  pulled into web bundles).

### Compatibility

Existing web consumers unchanged.

---

## [0.7.0] — 2026-05-17

### Added

- `retrySend(messageId)` — re-send a message previously marked
  `status: "failed"` reusing the same `messageId` so the peer sees
  one message, not two.
- `messageSendFailed` event — fires when the outbox gives up after
  max retries; payload includes the reason.

### Changed

- `ChatErrorCode` taxonomy tightened: codes now cover `peer_unreachable`,
  `auth_expired`, `offline`, `rate_limited`, `server_error`,
  `internal`. Use `err.code` to branch.
- `sendText` now throws on unreachable peer (previously logged + dropped).

---

## [0.6.0] — 2026-05-15

### Added

- **Multi-tab coordination via Web Locks API**. Two tabs of the same
  `(origin, user)` previously fought for the same `deviceId`-keyed WS
  slot on the dtelecom node, triggering an infinite reconnect war.
  Now only the tab holding the cross-tab lock runs the WS; secondary
  tabs sit silent and fire `tabConflict { role: "secondary" }` so the
  host app can render an "open elsewhere" overlay.
- `chat.isPrimary(): boolean` and `chat.takeOver(): Promise<void>`.
- `tabConflict` event with `{ role: "primary" | "secondary", activeAt }`.

### Compatibility

Browsers without `navigator.locks` (very old) or Node test envs fall
back to "always primary" — no-op.

---

## [0.5.0] — 2026-05-14

### Added

- **Persisted message status**. The SDK mirrors every in-memory
  `StatusTracker` transition into the stored message row, so the
  last-known `"sent"` / `"delivered"` / `"deliveredAll"` / `"read"`
  survives reload. `sendText` writes the initial row with
  `status: "pending"`.
- `messageSendFailed` event surface (full handler arrived in 0.7.0).
- `sendText` throws on `peer_unreachable` (e.g., claim_all returned
  no devices — peer has no registered devices or has blocked the
  caller server-side).

---

## [0.4.0] — 2026-05-13

### Changed (BREAKING)

- **Split HTTP and WS auth**. The chat JWT from `fetchChatToken` is
  now used ONLY for the dtelecom-node WS handshake. HTTP requests to
  the tenant backend (`/keys/*`, `/envelopes/*`) use a new required
  `fetchHttpBearer` callback returning whatever bearer the host
  backend's HTTP API accepts (Privy access token for dmeet; the chat
  JWT for the in-memory mock).

  Fixed a real bug: dmeet-backend's chat handlers use the existing
  Privy auth middleware, so the prior `Authorization: Bearer
  <chatToken>` HTTP header 401'd against the real backend. 0.3.0 only
  worked against the mock.

### Added

- `ConnectOptions.fetchHttpBearer: () => Promise<string>` (required).
- `FetchHttpBearer` and `FetchChatToken` types re-exported from the
  package root.

---

## [0.3.0] — 2026-05-12

### Added

- `listConversations()` — sorted-most-recent-first chat-list view
  derived from the local message store + per-peer read watermark.
- `connectionStateChange` event:
  `"connecting" | "open" | "reconnecting" | "closed"`.
- Local block filter: `setBlockedUserIds`,
  `getLocallyBlockedUserIds`, `ConnectOptions.initialBlockedUserIds`.
  Inbound from blocked peers is dropped silently before reaching
  `message` / `messageEdited` / `messageDeleted` handlers. Outbound
  filtering is the host backend's job (block rows the chat backend
  reads).

---

## [0.2.0] — 2026-05-11

### Changed

- `apiBaseURL` is now the **full** endpoint prefix (host + path), e.g.
  `https://your-host.example/api/secure-chat`. The SDK appends bare
  relative paths under it (`/token`, `/keys/upload`, etc.).

---

## [0.1.0] — 2026-05-09

Initial release. Core surface:

- `DTelecomSecureChat.connect(opts)`
- `sendText`, `editMessage`, `deleteMessage`, `markRead`, `setTyping`,
  `deleteConversation`
- `getHistory`, `setReadReceiptsEnabled`, `areReadReceiptsEnabled`,
  `markPeerDeviceVerified`, `getPeerDeviceFingerprint`,
  `getKnownPeerDevices`, `isPeerDeviceVerified`
- Events: `message`, `messageEdited`, `messageDeleted`, `readReceipt`,
  `typing`, `statusChange`, `peerNewDevice`
- Olm + vodozemac WASM crypto, MMKV / web / memory KV adapters.

[0.13.3]: https://github.com/dTelecom/secure-chat-client/releases/tag/v0.13.3
[0.13.2]: https://github.com/dTelecom/secure-chat-client/releases/tag/v0.13.2
[0.13.1]: https://github.com/dTelecom/secure-chat-client/releases/tag/v0.13.1
[0.13.0]: https://github.com/dTelecom/secure-chat-client/releases/tag/v0.13.0
[0.12.1]: https://github.com/dTelecom/secure-chat-client/releases/tag/v0.12.1
[0.12.0]: https://github.com/dTelecom/secure-chat-client/releases/tag/v0.12.0
[0.11.0]: https://github.com/dTelecom/secure-chat-client/releases/tag/v0.11.0
[0.10.0]: https://github.com/dTelecom/secure-chat-client/releases/tag/v0.10.0
[0.9.0]:  https://github.com/dTelecom/secure-chat-client/releases/tag/v0.9.0
[0.8.1]:  https://github.com/dTelecom/secure-chat-client/releases/tag/v0.8.1
[0.8.0]:  https://github.com/dTelecom/secure-chat-client/releases/tag/v0.8.0
[0.7.0]:  https://github.com/dTelecom/secure-chat-client/releases/tag/v0.7.0
[0.6.0]:  https://github.com/dTelecom/secure-chat-client/releases/tag/v0.6.0
[0.5.0]:  https://github.com/dTelecom/secure-chat-client/releases/tag/v0.5.0
[0.4.0]:  https://github.com/dTelecom/secure-chat-client/releases/tag/v0.4.0
[0.3.0]:  https://github.com/dTelecom/secure-chat-client/releases/tag/v0.3.0
[0.2.0]:  https://github.com/dTelecom/secure-chat-client/releases/tag/v0.2.0
[0.1.0]:  https://github.com/dTelecom/secure-chat-client/releases/tag/v0.1.0
