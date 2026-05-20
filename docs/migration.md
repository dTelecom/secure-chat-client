# Migration guide

Per-version upgrade notes. Skip to the version you're migrating FROM
— each section covers what changes you need to make to reach the
next published version. For the full feature history see
[`CHANGELOG.md`](../CHANGELOG.md).

---

## 0.11.0 → 0.12.0

**TL;DR:** No required changes; existing code keeps working.
New `not_found` / `not_authorized` / `edit_window_expired`
errors are now possible from `editMessage` / `deleteMessage`.

### What changed

- `editMessage` and `deleteMessage` now check the local store before
  shipping. They throw `ChatError` with new codes:
  - `"not_found"` — `targetId` isn't in the local store.
  - `"not_authorized"` — caller isn't the original sender.
  - `"edit_window_expired"` — `editMessage` only; message older than
    24h.
- `deleteConversation` is **deprecated** — use
  `deleteConversationForMe` (multi-device wipe) or
  `deleteConversationForEveryone` (also wipe peer's side). Old
  method still works; emits a TS deprecation hint.
- New events: `conversationDeletedBySelf`, `conversationDeletedByPeer`.
- `EDIT_WINDOW_MS` exported (= 24 × 3600 × 1000).
- `Conversation.lastMessage.editedAt` / `deletedAt` formally
  documented as UI badge signals (they were already there in 0.8.1,
  this is JSDoc only).

### What to update

1. **Replace `deleteConversation` calls**:

   ```ts
   // Before
   await chat.deleteConversation(peerUserId);

   // After (multi-device wipe of your side only)
   await chat.deleteConversationForMe(peerUserId);

   // Or (wipe both sides)
   await chat.deleteConversationForEveryone(peerUserId);
   ```

2. **Gate the edit affordance on the 24h window** ([recipe](ui-recipes.md#edit--delete-affordance-gating)):

   ```ts
   import { EDIT_WINDOW_MS } from "@dtelecom/secure-chat-client";

   const canEdit = msg.senderUserId === chat.currentUserId
                && msg.deletedAt == null
                && Date.now() - msg.sentAt < EDIT_WINDOW_MS;
   ```

   Without this, the user clicks "Edit", types, hits send, gets a
   confusing `edit_window_expired` error.

3. **Subscribe to `conversationDeletedByPeer`** for "Bob deleted the
   chat" toasts ([recipe](ui-recipes.md#peer-deleted-the-chat-handling)).

4. **Handle the new error codes** in your edit/delete error branches
   (see [`errors.md`](errors.md)).

5. **Show "edited" / "deleted" badges** using
   `StoredMessage.editedAt` and `.deletedAt`
   ([recipe](ui-recipes.md#message-row--edited--deleted-indicators)).

### Compatibility

SDK-only. No node change. New content events ride forward-compat
(unknown receivers drop silently) — a 0.11 receiver paired with a
0.12 sender simply doesn't honor the delete or edit-window enforcement.

---

## 0.10.0 → 0.11.0

**TL;DR:** **Requires dtelecom-node v1.1+** (livekit commit
`380468a9`). Coordinate the rollout. No SDK API change.

### What changed

- The delivery model is now **at-least-once with explicit
  client-device ACK**. The receiver SDK sends a new
  `chatEnvelopeAck` WS frame after durably storing each envelope.
  The node returns `chatSendResult.status = "live"` only on that
  ack — not on the prior optimistic "writeJSON returned nil"
  signal.
- Pre-decrypt **envelope dedup** (persisted LRU, capped at 1000
  entries per scoped user). Required because the new at-least-once
  layer ships up to 5 copies of each envelope; without dedup,
  Olm's replay rejection would corrupt sessions.
- Sender-side retry within `fallback_timeout` + one post-webhook
  publish — see [`delivery-semantics.md`](delivery-semantics.md).

### What to update

Nothing on the FE side. The new ack-after-store semantics are
internal; existing listeners and methods behave the same.

If you have an in-house mock / proxy of the dtelecom node, it must
implement the new `chatEnvelopeAck` frame and the `SignalDelivered`
flow — see `tasks/chat-client-ack.md` for the design.

### Compatibility note

A 0.11 SDK against a v1.0 node still works — the `chatEnvelopeAck`
frame is ignored by the old node, and the old optimistic semantics
prevail. You don't get the new guarantees, but nothing breaks.
Conversely, a 0.10 SDK against a v1.1 node never sends ack, so the
node always falls back to webhook (slow but functional).

dTelecom deploys both in lockstep so neither degraded state should
persist for real users.

---

## 0.9.0 → 0.10.0

**TL;DR:** Drop-in. Background discovery is on by default; can be
disabled or rate-limit-tuned if needed.

### What changed

- **Fixed**: mixed-msgType fanout. Outbound messages to peers with a
  mix of existing-session + new devices now correctly split into
  two `chatSend` frames per `msgType`. Pre-fix, half the recipients
  silently failed to decrypt. SDK-internal — no API impact.
- **Added**: background discovery polls `list_devices` after each
  send; ships catch-up envelopes to newly-discovered peer devices.

### What to update

Nothing required. If you want to tune:

```ts
const chat = await DTelecomSecureChat.connect({
  // ...
  backgroundDiscovery: true,            // default
  backgroundDiscoveryFloorMs: 30_000,   // default (rate-limit floor)
});
```

Set `backgroundDiscovery: false` to opt out (e.g. in tests). Set
`backgroundDiscoveryFloorMs: 0` to remove the rate-limit (e.g. in
tests that need every send to discover instantly).

---

## 0.8.1 → 0.9.0

**TL;DR (breaking):** `selfUserId` is now a required
`ConnectOptions` field. Add it.

### What changed

- All persisted SDK state lives under `u/<userId>/` scope. Two
  distinct users on the same device are isolated. Sign-out → sign-
  in as a different user no longer leaks state.
- New static `DTelecomSecureChat.wipeUserData(store, userId)` for
  explicit sign-out cleanup.
- `selfUserId` moved from "parsed from JWT at connect time" to
  "required at construction time" — eliminates a window where
  storage could be written under the wrong scope.

### What to update

1. **Add `selfUserId` to `connect()`**:

   ```ts
   // Before
   const chat = await DTelecomSecureChat.connect({
     apiBaseURL: "...",
     fetchChatToken: ...,
     fetchHttpBearer: ...,
     // selfUserId parsed from JWT
   });

   // After
   const chat = await DTelecomSecureChat.connect({
     apiBaseURL: "...",
     selfUserId: "alice",          // explicit and required
     fetchChatToken: ...,
     fetchHttpBearer: ...,
   });
   ```

   For dMeet: `selfUserId` is the Privy `did:privy:...` of the
   current user.

2. **Add a sign-out cleanup step**:

   ```ts
   async function signOut() {
     const userId = chat.currentUserId;
     await chat.disconnect();
     if (userId) {
       await DTelecomSecureChat.wipeUserData(store, userId);
     }
   }
   ```

   Without this, the previous user's namespace stays in the KV but
   inert (the new user's scope is separate; correctness is fine).
   `wipeUserData` reclaims the storage.

3. **Existing 0.8.x users** — bootstrap auto-migrates legacy unscoped
   keys into the connecting user's scope. One-shot, idempotent.
   First connect after upgrade may take a beat longer.

---

## 0.7.x → 0.8.0

**TL;DR:** Drop-in for web. **React Native users**: ensure
`@dtelecom/vodozemac-rn` is installed.

### What changed

- React Native support via the `#vodozemac` subpath import. Metro
  bundles the native module (`@dtelecom/vodozemac-rn`); web bundles
  the WASM build (`@dtelecom/vodozemac-wasm`).

### What to update

For RN:
```sh
npm install @dtelecom/vodozemac-rn
# follow the native-bridge setup in /tasks/rn-native-bridge.md
```

For web: nothing.

---

## 0.6.0 → 0.7.0

**TL;DR:** Drop-in. New `retrySend` API; existing methods unchanged.
`ChatErrorCode` taxonomy formalized.

### What changed

- `retrySend(messageId)` method. `messageSendFailed` event.
  `ChatErrorCode` formalized: `peer_unreachable`, `auth_expired`,
  `offline`, `rate_limited`, `server_error`, `internal`.
- `sendText` now throws on unreachable peer (previously logged + dropped).

### What to update

If you previously called `sendText` without try/catch and ignored
failures, wrap it now to surface `peer_unreachable` to the user.
Sample:

```ts
try {
  await chat.sendText(peerUserId, text);
} catch (err) {
  if (err instanceof ChatError && err.code === "peer_unreachable") {
    toast("Can't reach this user");
  } else {
    throw err;
  }
}
```

---

## 0.5.0 → 0.6.0

**TL;DR:** Drop-in. New tab coordination — render an "open
elsewhere" overlay if you support multi-tab.

See [`multi-device.md`](multi-device.md#tab-coordination-browser) for
the recipe. Without the overlay, secondary tabs just appear non-
functional (sends queue and eventually fail) — annoying but not
broken.

---

## 0.4.0 → 0.5.0

**TL;DR:** Drop-in. New `statusChange` event, persisted message
status.

You may want to render delivery indicators per
[`ui-recipes.md`](ui-recipes.md#status-indicators-) now that the SDK
exposes them.

---

## 0.3.0 → 0.4.0

**TL;DR (breaking):** Split HTTP and WS auth. Add the new
`fetchHttpBearer` callback.

### What changed

- The chat JWT from `fetchChatToken` is now used ONLY for the WS
  handshake. HTTP requests use a new required `fetchHttpBearer`
  callback returning whatever bearer the host backend's HTTP API
  accepts.

### What to update

```ts
// Before
const chat = await DTelecomSecureChat.connect({
  apiBaseURL: "...",
  fetchChatToken: ...,
});

// After
const chat = await DTelecomSecureChat.connect({
  apiBaseURL: "...",
  fetchChatToken: ...,
  fetchHttpBearer: async () => getPrivyAccessToken(), // or your host's session bearer
});
```

For dMeet specifically: `fetchHttpBearer` returns the Privy access
token (same value the rest of the app's `/api/*` routes already
accept).

---

## 0.2.0 → 0.3.0

**TL;DR:** Drop-in. Adds `listConversations`,
`connectionStateChange`, block list. Use any that fit.

---

## 0.1.0 → 0.2.0

**TL;DR (breaking):** `apiBaseURL` is now the full endpoint prefix
(host + path), not just the host.

### What to update

```ts
// Before
apiBaseURL: "https://your-host.example"

// After
apiBaseURL: "https://your-host.example/api/secure-chat"
```

---

## See also

- [`CHANGELOG.md`](../CHANGELOG.md) — every version's release notes
- [`events.md`](events.md) — full event reference
- [`errors.md`](errors.md) — full error reference
