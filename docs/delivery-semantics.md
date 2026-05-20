# Delivery semantics

How a message actually gets from A to B. What `chatSendResult.status`
means. What guarantees the SDK gives. **Required reading if you're
building status indicators or recovery UX.**

The current model dates from 0.11.0 (client-device ACK delivery) and
the dtelecom-node v1.1 deploy.

---

## The big picture

Each outbound message follows this path:

```
alice's SDK   →   alice's dtelecom node   →   bob's dtelecom node   →   bob's SDK
                                                      │
                                                      └─ on timeout →   webhook → tenant backend
                                                                              │
                                                                              └─ bob's next reconnect → /envelopes/pending → drain
```

Two delivery paths:
- **Live**: WS write → client ack. Fast (< 500ms typical).
- **Stored**: timeout (2s) → webhook POST to tenant backend → bob
  pulls via `/envelopes/pending` when he reconnects.

Both end with bob's SDK calling `messages.put` and firing
`message`. From the FE's perspective the two paths are
indistinguishable in the final state — the difference is
*latency* (live = milliseconds, stored = until next reconnect).

---

## `chatSendResult.status` values

The node returns one of four statuses per target after every send:

| `status`    | Meaning                                          | What happened                                                                 |
|-------------|--------------------------------------------------|-------------------------------------------------------------------------------|
| `"live"`    | Recipient SDK acked within `fallback_timeout`    | Live WS write + recipient's `chatEnvelopeAck` → SDK durably stored it         |
| `"stored"`  | Timeout; envelope POSTed to webhook              | Recipient was offline or unresponsive → backend has the message               |
| `"dropped"` | Ephemeral envelope, no ack, no fallback          | Typing indicator etc. — never persisted                                       |
| `"error"`   | Invalid target, oversize, etc.                   | `error` field carries the reason                                              |

The SDK's `StatusTracker` collapses `"live"` and `"stored"` both into
the internal `"sent"` status — the FE typically can't and shouldn't
distinguish them (the message reached the system; whether via live
WS or via the offline-queue is an implementation detail).

The next-step transitions (`"delivered"` etc.) come from the peer's
`received` content events — see [`events.md`](events.md) under
`statusChange`.

---

## What "live" actually guarantees

`"live"` means **the recipient SDK called `messages.put` for this
envelope**. Specifically:

1. The recipient's WebSocket was open.
2. The recipient's `handleInboundCiphertext` decrypted the ciphertext.
3. The decrypted event was dispatched to `dispatchInboundEvent`.
4. `messages.put` resolved (durably written to the recipient's KV).
5. The SDK then sent a `chatEnvelopeAck` WS frame back to the node.
6. The node's `SignalDelivered` woke the sender's inflight channel
   (same-node) or published a `MeshKindAck` (cross-node).

If ANY of these failed (WS closed mid-decrypt, store-write threw,
node failed to route the ack), the sender's inflight channel never
fires and the node falls through to the timeout-then-webhook path.

**What "live" does NOT mean:**
- The recipient's UI rendered the message. (The SDK has it stored;
  the UI's `message` event fires next, but app code may not have
  attached a listener, may be on a different screen, etc.)
- The recipient *read* the message. That's a separate `read` event
  emitted only when the user explicitly marks-read (or scrolls past).

---

## What "stored" actually guarantees

`"stored"` means **the envelope is in the tenant backend's
`/envelopes/pending` queue for the recipient device**. It will be
delivered on the recipient's next reconnect:

1. Recipient's SDK reconnects (`connect()` or auto-reconnect).
2. On WS open, the SDK drains via `GET /envelopes/pending`.
3. Each pending envelope feeds through the same pipeline as a live
   chatEnvelope frame (with `source: "drain"`).
4. After successful decrypt + store, the SDK calls
   `POST /envelopes/ack` to remove from the queue.

For each envelope drained, the recipient's `message` event fires
exactly once. **But:** these events fire *synchronously during
`connect()`*, before app code can attach a listener for a freshly-
constructed SDK instance. So on cold start, use `getHistory` to
recap; only `message` events from after `connect()` resolves are
reachable.

If the recipient never reconnects (e.g., deleted the app), the
envelope sits in the backend queue forever. The tenant backend
applies its own TTL.

---

## At-least-once + dedup

The node's sender-side retry loop (every 500ms within the 2s
`fallback_timeout`) and the post-webhook publish mean **the same
envelope can arrive multiple times** at the recipient:

- Retry catches a recipient who reconnects mid-flow.
- Post-webhook publish catches a recipient who reconnects between
  the last retry tick and the webhook POST completing.
- Live WS + `/envelopes/pending` drain could BOTH deliver if the
  recipient reconnects right when the webhook fires.

The SDK handles this with **pre-decrypt envelopeUuid dedup**
(`EnvelopeDedup`, persisted under `envelopeDedup/<uuid>`, cap 1000
entries per user). The flow:

```
chatEnvelope arrives
  └─ envelopeDedup.has(uuid)?
       ├─ YES → re-ack (sender retry may have lost our previous ack), return early
       └─ NO  → envelopeDedup.add(uuid), decrypt, dispatch, ack
```

Net effect: `message` (and `messageEdited`, etc.) fire EXACTLY ONCE
per logical envelope, even when the wire layer ships it 2-5 times.

This is critical for Olm: a naive replay of the same ciphertext
would fail Olm's ratchet check, which the recovery path interprets
as session corruption — `forgetPeerDevice` then nukes the session.
Pre-decrypt dedup keeps the ratchet healthy.

---

## Retry budget

The node retries the publish 4 times within the 2s `fallback_timeout`:
- t = 0     — initial publish
- t = 0.5s  — retry 1
- t = 1.0s  — retry 2
- t = 1.5s  — retry 3
- t = 2.0s  — timeout → webhook fallback
- t ≈ 2.5s  — one final post-webhook publish (1s budget)

If the recipient reconnects between any of these and acks, the
sender sees `"live"`. If none catches the recipient, the sender sees
`"stored"` and the recipient picks up via `/envelopes/pending`.

---

## Failure modes the SDK handles

| Failure                                | Sender sees | Recipient gets    |
|----------------------------------------|-------------|-------------------|
| Recipient online, healthy WS, no race  | `live`      | live via WS       |
| Recipient WS closes during send        | `live`*     | live or via drain |
| Recipient was offline                  | `stored`    | via drain         |
| Recipient reconnects to different node | `live`*     | live or via drain |
| Recipient device deleted               | `stored`    | never (backend TTL eventually drops) |
| Peer has no devices at all             | throws `peer_unreachable` | — |

`*` Within the 2s retry window, the retry loop catches it. Outside,
falls back to `stored`.

---

## What this means for the FE

### Status indicators

Use `StoredMessage.status`, mirrored from `StatusTracker`. The
ladder is `pending → sent → delivered → deliveredAll → read`. Don't
build custom heuristics on top of `chatSendResult`; the SDK already
collapses correctly.

### Loading screen / spinner

After `connect()` resolves, the SDK drains `/envelopes/pending`
asynchronously. The view is initialized via `getHistory`; new
arrivals trigger `message` events. There's no "loading messages…"
state to render — the drain is fast (~100ms for hundreds of
envelopes) and the chat list / conversation view re-renders via
events.

### Network resilience

The SDK auto-reconnects with exponential backoff (capped at 30s).
The outbox preserves outbound sends across disconnects; they ship
on the next "open" transition. Listen to
`connectionStateChange` if you want to show a "reconnecting…" pill.

### What about message ordering across the retry path?

Each envelope carries the sender's `clientSentAt`. The recipient
sorts by `sentAt`, not by wire-arrival order. So if alice sends m1,
m2, m3 and m2's webhook arrives before m1's retry catches up, the
recipient's view still shows m1, m2, m3 in the right order.

`clientSentAt` is sender-controlled and untrustworthy for security
purposes (an evil sender could backdate), but for ordering inside a
single conversation it's the only practical thing — the alternative
is per-conversation server-side counters which we don't have.

---

## See also

- [`events.md`](events.md) — `statusChange`, `messageSendFailed`
- [`errors.md`](errors.md) — `peer_unreachable`, `offline`, etc.
- [Wire contract](../../tasks/chat-wire-contract.md) §3 — the
  `chatSendResult` and `chatEnvelopeAck` frames at the byte level
- [Client-ACK design doc](../../tasks/chat-client-ack.md) — the
  reasoning behind the 0.11.0 delivery rewrite
