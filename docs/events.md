# Events reference

Every event the SDK fires, with its payload shape, when it triggers,
and the typical UI reaction. All 13 events are reachable via:

```ts
const unsubscribe = chat.on("eventName", (payload) => { /* ... */ });
unsubscribe(); // detach when the component unmounts
```

Listeners are called synchronously after the SDK has updated its
persisted state. So if you `await chat.getHistory(...)` from inside a
listener, you'll see the change reflected.

---

## `message`

Inbound text from a peer (or self-echo from your own sibling device).

```ts
interface MessageReceived {
  peerUserId: string;       // who the conversation is with
  peerDeviceId: string;     // which of their devices sent this
  senderUserId: string;     // who authored it. === selfUserId on self-echo
  message: {
    id: string;
    text: string;
    replyTo?: string;
    sentAt: number;         // sender's clientSentAt, ms epoch
  };
}
```

**Fires:**
- Each time a peer sends you text.
- Each time one of your OWN sibling devices sends a message to a peer
  (self-echo). UI shows it as your own outbound row — distinguish via
  `senderUserId === chat.currentUserId`.

**Not fired for:** edits, deletes, your own outbound `sendText` calls
(those go through the store directly). For "recap of unread on mount,"
read `chat.getHistory(peerUserId)` instead of replaying events.

**Note on UI race**: `drainPending` fires `message` synchronously during
`connect()` — *before* your code can attach a listener for a fresh SDK
instance. For "show recent messages on mount" use `getHistory`, then
attach the listener for live updates.

---

## `messageEdited`

A previously-sent message was edited by its original author. The SDK
has already updated the stored row's `text` and set `editedAt` by the
time this fires.

```ts
interface MessageEdited {
  peerUserId: string;
  editorUserId: string;     // === senderUserId of the original. === selfUserId on self-echo.
  targetId: string;         // id of the message being edited
  newText: string;
  editedAt: number;
}
```

**Fires:** when a peer edits a message they previously sent you (within
the 24h window — see `EDIT_WINDOW_MS`), or when your sibling edits via
self-echo.

**Not fired when:** the edit was past the 24h window (receiver drops
silently), or when the edit's `editorUserId` doesn't match the stored
row's `senderUserId` (forgery attempt; silently dropped).

**Typical UI:** update the rendered text + show an "edited" badge
(`message.editedAt !== null`).

---

## `messageDeleted`

A previously-sent message was tombstoned by its original author. The
SDK has already wiped the stored row's `text` and set `deletedAt` by
the time this fires.

```ts
interface MessageDeleted {
  peerUserId: string;
  deleterUserId: string;    // === senderUserId of the original. === selfUserId on self-echo.
  targetId: string;
  deletedAt: number;
}
```

**Typical UI:** replace the message bubble with a "this message was
deleted" placeholder (`message.deletedAt !== null`).

---

## `readReceipt`

The peer marked everything up to a given message id as read.

```ts
interface ReadReceiptEvent {
  peerUserId: string;
  peerDeviceId: string;
  upToId: string;
}
```

**Fires** only when the peer has read receipts enabled
(`setReadReceiptsEnabled(true)` on their end). The local side's
StatusTracker also consumes this and promotes own-outbound statuses to
`"read"`.

---

## `typing`

The peer started or stopped typing in this conversation. Ephemeral —
never persisted, never delivered offline.

```ts
interface TypingEvt {
  peerUserId: string;
  peerDeviceId: string;
  state: "started" | "stopped";
}
```

**Typical UI:** show a "Bob is typing…" indicator under the conversation
header. Clear when `state === "stopped"` OR when a `message` arrives
from the same peer.

---

## `statusChange`

Outbound message status moved one step up the ladder. The SDK has
already mirrored the new status into the stored row by the time this
fires.

```ts
interface StatusChangeEvt {
  peerUserId: string;
  messageId: string;
  status: "pending" | "sent" | "delivered" | "deliveredAll" | "read" | "failed";
}
```

Status ladder:
- `"pending"` — initial state at `sendText` time, before the WS send.
- `"sent"` — node accepted via `chatSendResult.status` ∈ {`"live"`,`"stored"`}.
- `"delivered"` — peer's first device sent a `received` ack.
- `"deliveredAll"` — every known peer device has sent `received`.
- `"read"` — peer's `read` watermark passed this message's id.
- `"failed"` — outbox gave up after max retries (terminal).

See `delivery-semantics.md` for the `"live"` vs `"stored"` distinction
in `chatSendResult`.

**Typical UI:** render the usual ✓ / ✓✓ / "Read" indicators on the
message row.

---

## `peerNewDevice`

The SDK observed a previously-unknown device of an existing peer
(either via an inbound prekey-message from it or via a refreshed
device list). Fires exactly once per `(peerUserId, peerDeviceId)`.

```ts
interface PeerNewDeviceEvt {
  peerUserId: string;
  peerDeviceId: string;
  fingerprint: string;
}
```

**Typical UI:** "Bob is using a new device — verify?" banner. After
the user verifies out-of-band, call
`chat.markPeerDeviceVerified(peerUserId, peerDeviceId, true)`.

---

## `conversationsChanged`

A conversation row's `lastMessage*` or `lastReadFromPeerAt` moved, OR
a conversation was deleted. Use this to invalidate the chat-list view.

```ts
interface ConversationsChangedEvt {
  changed: string[];        // peerUserIds whose row moved
  totalUnread: number;      // sum across ALL conversations (badge use)
}
```

**Typical UI:** re-fetch `chat.listConversations()` and re-render the
list — small enough to be cheap. The badge in your bottom-nav can
read `totalUnread` directly without re-walking the list.

---

## `conversationDeletedBySelf` *(new in 0.12.0)*

Fired on this device when the local user (or one of their sibling
devices) called `deleteConversationForMe` or
`deleteConversationForEveryone`. The SDK has already wiped local
history + the conversation row by the time this fires.

```ts
interface ConversationDeletedBySelfEvt {
  peerUserId: string;
  scope: "me" | "everyone";
}
```

**Typical UI:** the chat is gone from `listConversations` already.
The `conversationsChanged` event also fires; this dedicated event
exists so the host can optionally toast "Chat deleted" without
diffing the list.

---

## `conversationDeletedByPeer` *(new in 0.12.0)*

Fired when the peer called `deleteConversationForEveryone` on this
thread. The SDK has already wiped local history + the conversation
row by the time this fires.

```ts
interface ConversationDeletedByPeerEvt {
  peerUserId: string;
}
```

**Typical UI:** toast "Bob deleted the chat" or similar. The chat is
already gone from `listConversations`.

**Replay-safe:** the SDK's watermark guard drops stale delete events.
You won't see this fire from a long-delayed offline-pending replay
after the user has re-engaged with the peer.

---

## `connectionStateChange`

The underlying WebSocket changed state.

```ts
interface ConnectionStateChangedEvt {
  state: "connecting" | "open" | "reconnecting" | "closed";
}
```

**Typical UI:** show a "reconnecting…" toast or pill in the header
when `state !== "open"`. Auto-reconnect with exponential backoff is
handled by the SDK.

---

## `messageSendFailed`

The outbox gave up retrying an outbound message. The stored row's
`status` is also written to `"failed"` so the UI can render a "failed"
indicator after reload.

```ts
interface MessageSendFailedEvt {
  peerUserId: string;
  messageId: string;
  reason: "max_attempts_exceeded";
}
```

**Typical UI:** error pill on the message row with a "retry" button
that calls `chat.retrySend(messageId)`.

---

## `tabConflict` *(browser-only)*

This SDK instance's tab role changed. Two tabs of the same
`(origin, user)` use the Web Locks API to coordinate; only the
primary tab runs the WebSocket and processes live traffic.

```ts
interface TabConflictEvt {
  role: "primary" | "secondary";
  activeAt: number;         // ms epoch of this transition
}
```

**Typical UI:** when `role === "secondary"`, show an "open elsewhere"
overlay with a "Use here" button that calls `chat.takeOver()` to
steal primary status. When `role === "primary"`, hide the overlay
and render normal UX.

Fires:
- Once at boot if `connect()` finds another tab already primary.
- When this tab gets stolen-from (another tab called `takeOver`).
- When this tab promotes (either via `takeOver` here, or because the
  previous primary disconnected and our background wait fired).

On browsers without the Web Locks API (very old) or in non-browser
environments, the SDK behaves as if always primary and this event
never fires.

---

## Listener cleanup

`chat.on(...)` returns an unsubscribe function. Call it when your
component unmounts to avoid leaks across re-mounts:

```ts
useEffect(() => {
  const off1 = chat.on("message", onMessage);
  const off2 = chat.on("conversationsChanged", refreshList);
  return () => { off1(); off2(); };
}, []);
```

---

## See also

- [`errors.md`](errors.md) — every `ChatError.code` and how to handle it
- [`ui-recipes.md`](ui-recipes.md) — concrete component patterns
- [`delivery-semantics.md`](delivery-semantics.md) — what `statusChange`'s
  status values mean under the hood
