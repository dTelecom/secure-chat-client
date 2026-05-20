# Multi-device guide

Every user has N devices: phone, laptop, browser tab 1, browser tab 2,
etc. The SDK keeps them in sync so each one sees the same conversation
state. This guide explains the mechanics so FE writers know what to
expect.

---

## The three planes

1. **Sibling devices of the same user** (alice-phone + alice-laptop)
   — different `(userId, deviceId)` pairs, same `userId`. Kept in
   sync via *self-echo*.
2. **Peers** (alice → bob) — different `userId`s. Standard
   fanout-multi-device delivery: alice's send is encrypted once per
   bob device.
3. **Tabs of the same device** (alice-laptop, two Chrome tabs) —
   same `deviceId` would compete for the same WebSocket slot on the
   dtelecom node. Resolved via *tab coordination*.

---

## Self-echo (sibling sync)

When alice-phone sends a message to bob, the SDK *also* encrypts the
same message under alice's own Olm keys and ships it to her other
devices (alice-laptop, alice-browser-tab). Each sibling decrypts and
applies — they see the outbound message in their conversation view
as if it were their own.

This is symmetric for edits, deletes, read receipts, and the new
delete-conversation events:

- alice-phone calls `chat.editMessage(...)` → alice-laptop's
  `messageEdited` event fires.
- alice-phone calls `chat.markRead(...)` → alice-laptop's
  `readReceipt` consumption advances local watermark, unread count
  drops to match.
- alice-phone calls `chat.deleteConversationForMe(...)` →
  alice-laptop's `conversationDeletedBySelf({scope:"me"})` fires;
  alice-laptop wipes too.

The Olm session binding guarantees authenticity: only alice's
authentic devices can produce ciphertext that decrypts under
alice's own inbound key state. A peer can't forge a self-echo
event impersonating you.

### What this means for the FE

You don't need to do anything special. Listeners fire on every
device of the user; the local state machine converges automatically.

**Exception**: outbound `message`-event semantics. When alice-phone's
`sendText(bob, "hi")` fires:
- alice-phone — `message` event does NOT fire on the *originating*
  device. The SDK writes to its own store directly.
- alice-laptop — `message` event DOES fire (the self-echoed payload
  arriving as inbound). `senderUserId === chat.currentUserId`, which
  is how the UI distinguishes it from a peer-authored message.

```ts
chat.on("message", (e) => {
  const isMine = e.senderUserId === chat.currentUserId;
  // ...render outbound bubble if isMine, inbound otherwise
});
```

### Self-echo to a new sibling device

When alice-laptop registers for the first time, alice-phone doesn't
know it exists yet. The next time alice-phone calls `sendText`, the
SDK's *background discovery* layer (added in 0.10.0) detects the new
device via a low-cost `list_devices` poll and ships a *catch-up
envelope* for the in-flight message — so alice-laptop receives the
message it would otherwise have missed.

If alice-phone is offline when alice-laptop registers, alice-laptop
just won't receive past messages — the SDK has no historical-sync.
This matches Signal's "no message backup" stance. Frontends should
NOT promise "see all your past messages on this new device" UX.

---

## Conversation list across siblings

`listConversations()` is derived from the local message store and a
per-peer read watermark. Both are kept in sync across siblings via
the events above, so the chat list converges.

`unreadCount` per peer = (peer-authored messages with `sentAt >
lastReadFromPeerAt`). When alice-phone reads, the `read` event
self-echoes to alice-laptop, which advances *its* watermark, which
drops *its* unread count to match.

There's a brief window during connect / drainPending where the
sibling-sync events haven't landed yet — the unread count may show
the old value for ~1-2 seconds. Don't fight it with custom logic;
`conversationsChanged` fires once the state settles and the UI
re-reads correctly.

---

## Per-user scoped storage (sign-out cleanup)

Since 0.9.0 the SDK persists all state under a `u/<userId>/` prefix.
Two distinct users on the same browser/device are physically isolated
in the KV store. Olm sessions, message history, conversation index,
block list, dedup set, delete watermark — all scoped.

**On sign-out:**

```ts
const userId = chat.currentUserId;
await chat.disconnect();
if (userId) {
  await DTelecomSecureChat.wipeUserData(store, userId);
}
```

`wipeUserData` drops every key under the user's scope and returns
the count deleted. Skipping this leaves the previous user's
namespace inert but present — fine for correctness (the new user's
scope is separate), but the storage grows over time as users come
and go.

---

## Tab coordination (browser)

Two tabs of the same `(origin, user)` would otherwise compete for
the same `deviceId`-keyed WS slot on the dtelecom node, causing an
infinite reconnect war. The SDK uses the Web Locks API (since
0.6.0) to coordinate.

### Default behavior

The FIRST tab to call `connect()` wins the lock and is *primary*:
WebSocket open, processing live traffic, full UX.

Subsequent tabs are *secondary*: WebSocket closed, listeners fire
only for events the primary triggers locally
(`listConversations()` etc. still work as read-only against the
shared persisted store; outbound sends queue in the local outbox
but ultimately fail with `messageSendFailed`).

### tabConflict event

```ts
chat.on("tabConflict", (e) => {
  if (e.role === "secondary") {
    showOpenElsewhereOverlay();
  } else {
    hideOverlay();
  }
});
```

The secondary tab's UI should show "open elsewhere" with a "Use here"
button that calls `chat.takeOver()` — this steals the lock, opens
the WS in the current tab, and fires `tabConflict({role:"secondary"})`
on the previously-primary tab.

### Methods

- `chat.isPrimary(): boolean` — sync getter.
- `chat.takeOver(): Promise<void>` — steal primary status. Resolves
  once this tab's WS is open and ready.

### Non-browser

On engines without `navigator.locks` (very old browsers, Node
tests, React Native) the SDK behaves as if always primary —
`tabConflict` never fires and `takeOver` is a no-op resolution.
You don't need to special-case this.

---

## Background discovery + catch-up envelopes

**Problem:** alice sends to bob. Bob has just added a new device
bob-watch. alice's bundleCache for bob doesn't include bob-watch yet
— the message ships only to bob's known devices.

**Fix (since 0.10.0):** every `encryptForPeer` kicks off a background
`list_devices` poll for the peer. If a new device appears, the SDK
refreshes the bundleCache AND ships a *catch-up envelope* for the
in-flight plaintext to the new device only — so bob-watch receives
the message without needing to ever send first.

Rate-limited via `backgroundDiscoveryFloorMs` (default 30s) so a
chatty burst doesn't fire one list_devices per message.

```ts
const chat = await DTelecomSecureChat.connect({
  // ...
  backgroundDiscovery: true,            // default
  backgroundDiscoveryFloorMs: 30_000,   // default
});
```

You can disable for testing (`backgroundDiscovery: false`) but in
production this is what makes "I added a new device and started
receiving messages immediately" work.

---

## Common pitfalls

### "My sibling's edits aren't showing up on my device"

Almost always means one of:
1. The sibling's send completed but the WS layer dropped before
   the self-echo could land. Wait for connectivity to come back;
   the SDK's at-least-once delivery (0.11.0) handles the retry.
2. The tab is *secondary* and isn't running the WS. `chat.isPrimary()`
   to verify.
3. The SDK on this device hasn't been registered as a sibling yet
   — the sender's `claim_all` from before your device-registration
   wouldn't include you. Once the sibling sends *next*, the
   catch-up envelope from background discovery brings you up to
   date.

### "I see a peer's message twice"

Should never happen — the SDK dedups on `envelopeUuid` pre-decrypt.
If you're seeing this, file a bug.

### "I see my own outbound twice"

The originating device shows the message via the local-store-write
path; siblings show it via the self-echo `message` event. If your
UI re-renders on both paths from a *single* device, that's a UI
bug (you may be subscribing to `message` AND watching the store
state directly).

---

## See also

- [`delivery-semantics.md`](delivery-semantics.md) — at-least-once
  delivery and the client-device ACK flow (0.11.0)
- [`events.md`](events.md) — payload shapes for all events
