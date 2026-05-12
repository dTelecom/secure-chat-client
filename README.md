# @dtelecom/secure-chat-client

TypeScript SDK for end-to-end encrypted 1:1 chat over the dTelecom mesh. Olm via vodozemac, fanout multi-device, multi-device sync (Signal-style), self-echo, offline-fallback delivery, content-protocol forward compat.

## Status

v0.4.0 — feature complete.

> **v0.4.0 breaking change vs v0.3.0:** HTTP and WS auth are now **separate**. The chat token from `fetchChatToken` is reserved for the dtelecom-node WS handshake; HTTP requests use a new required `fetchHttpBearer` callback (for dmeet this is the Privy access token — same bearer every other `/api/*` route already expects). The previous design (re-using the chat token for HTTP) only worked against the in-memory mock — the dmeet-backend HTTP routes use Privy auth, so 0.3.0 couldn't actually talk to a real backend. Update consumers:
> ```diff
>  const chat = await DTelecomSecureChat.connect({
>    apiBaseURL: "https://app.example/api/secure-chat",
>    fetchChatToken: async (deviceId) => { /* mint endpoint */ },
> +  fetchHttpBearer: async () => getPrivyAccessToken(),
>  });
> ```

> **v0.3.0 changes vs v0.2.0:**
> - **Add** `chat.listConversations()` + the `conversationsChanged` event — a per-peer threads index derived from the local message store + a per-peer read watermark, persisted via the configured KV adapter. Unread counts converge across own devices because `markRead` self-echoes.
> - **Add** `chat.on("connectionStateChange", …)` — surfaces the WS state (`"connecting" | "open" | "reconnecting" | "closed"`) so the UI can render an offline / reconnecting banner.
> - **Add** `chat.currentUserId` getter (parsed from the chat token's `sub` claim).
> - **Add** `chat.deleteConversation(peerUserId)` — wipes the thread's stored messages + index row locally. Doesn't tear down the Olm session, so future inbound from the peer will re-create the thread (use the host's block UX if you want the peer's traffic dropped entirely).
> - **Local-side effect on `chat.markRead()`** — now always advances the local "last-read-from-peer" watermark (driving the unread count) even when outbound read receipts are disabled via `setReadReceiptsEnabled(false)`.
> - **Remove** `chat.blockUser()` / `chat.unblockUser()` / `chat.getBlockedUsers()`. Hosts with their own user-block UX (e.g. dmeet's `/api/users/block-user`) write to the same row the chat handlers query, so chat-specific block methods were duplicate surface. The contract's `/blocks` endpoints stay in the in-memory mock for smoke tests; production backends don't need them.
> - **Add** `chat.setBlockedUserIds(ids[])` + `chat.getLocallyBlockedUserIds()` + `connect({ initialBlockedUserIds })`. The block list itself lives in the host (e.g. dmeet) — the SDK only keeps a local mirror so inbound messages from a now-blocked peer arriving over an EXISTING Olm session (which is NOT torn down on block, by design — see plan §14) get dropped before they hit the UI. Persisted in KV so a cold-start drain doesn't briefly leak blocked content before the host re-pushes its view.

> **v0.2.0 breaking change vs v0.1.0:** `apiBaseURL` is now the FULL endpoint prefix (host + path), and the SDK appends bare relative paths (`/token`, `/keys/upload`, `/envelopes/pending`, etc.) instead of hardcoding `/api/chat/`. Update consumers from `apiBaseURL: "https://app.example"` → `apiBaseURL: "https://app.example/api/secure-chat"` (or wherever the backend mounts the API).

- 96/96 unit + 2/2 browser + 18/18 integration smokes against the deployed dTelecom mesh on Solana devnet
- vodozemac (Rust → WASM, our `@dtelecom/vodozemac-wasm` crate) — libolm-compatible wire format
- Browser (Chrome/Edge/Safari/Firefox via Vitest browser-mode) and Node (tsx + Vitest) both validated
- React Native: works on RN 0.84+ / Hermes V1 (WebAssembly support); UniFFI native binding deferred

## Install

```sh
npm install @dtelecom/secure-chat-client
```

`@dtelecom/vodozemac-wasm` is a peer-of-this-package dep (resolved transitively).

## Quick start

```ts
import { DTelecomSecureChat } from "@dtelecom/secure-chat-client";

const chat = await DTelecomSecureChat.connect({
  // Full endpoint prefix — host + path. The SDK appends bare relative
  // paths under it (e.g. /token, /keys/upload, /envelopes/pending).
  apiBaseURL: "https://your-tenant-backend.example/api/secure-chat",
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

// Who is the signed-in user? (parsed from the chat token's `sub` claim)
chat.currentUserId;

chat.on("message", (e) => console.log(e.peerUserId, "→", e.message.text));
chat.on("messageEdited", (e) => /* ... */);
chat.on("messageDeleted", (e) => /* ... */);
chat.on("statusChange", (e) => /* sent → delivered → deliveredAll → read */);
chat.on("typing", (e) => /* started / stopped */);
chat.on("readReceipt", (e) => /* upTo a given message id */);
chat.on("peerNewDevice", (e) => /* TOFU UI */);
chat.on("conversationsChanged", () => /* re-render the chat list */);
chat.on("connectionStateChange", (e) => /* "connecting" | "open" | "reconnecting" | "closed" */);

await chat.sendText("bob-user-id", "hi bob");
await chat.editMessage("bob-user-id", messageId, "edited");
await chat.deleteMessage("bob-user-id", messageId);
await chat.markRead("bob-user-id", messageId);
chat.setTyping("bob-user-id", true);

// Conversation list for the chat tab. Each entry has lastMessageAt + a
// snapshot of the latest message + an unread count. Sorted most-recent-
// first. Empty on a brand-new device (no historical sync).
const convs = await chat.listConversations();

const history = await chat.getHistory("bob-user-id", { limit: 50 });

// "Remove from list" UX — wipes the thread's stored messages + index row
// locally. The Olm session stays alive; future inbound from this peer
// re-creates the thread.
await chat.deleteConversation("bob-user-id");

// Push the host's current block list whenever it changes (e.g. user
// hits "Block" in dmeet's profile UI).
await chat.setBlockedUserIds(["bad-user-1"]);

await chat.setReadReceiptsEnabled(false);
await chat.markPeerDeviceVerified("bob", "bob-phone", true);
const fingerprint = await chat.getPeerDeviceFingerprint("bob", "bob-phone");

// Block / unblock is intentionally NOT in this SDK — host apps with their
// own block UX (e.g. dmeet's /api/users/block-user) write the same rows
// the chat backend reads for silent-filter on claim_all + envelope POST.
```

## Architecture

The SDK does NOT bundle Solana RPC or STUN. Node discovery is delegated to the tenant backend: `POST /api/chat/token` returns a chat-token JWT plus the closest dtelecom node's WebSocket URL (`chatNodeWsUrl`), computed server-side via `@dtelecom/server-sdk-js`. This keeps the browser bundle small and reuses the same node-selection logic as room WebRTC.

Wire contract: `chat-wire-contract.md` (in the dTelecom monorepo).
Architecture: `secure-chat-plan.md`.

## Bundle size

| Artefact | Raw | Gzipped |
|---|---|---|
| `dist/index.js` (ESM) | 73 kB | 17.6 kB |
| `dist/index.cjs` (CJS) | 73 kB | 17.8 kB |
| `dist/index.d.ts` | 17 kB | 5.2 kB |
| `vodozemac-wasm` `.wasm` | 401 kB | 184.8 kB |
| `vodozemac-wasm` JS glue | 25 kB | 5.0 kB |
| **Total runtime cost** | — | **~207 kB gzipped** |

Budget was 1.5 MB; we're well under. The WASM is lazy-loaded on first `chat.connect()` — initial app boot pays only the SDK JS (~17.6 kB gz).

## Tests

### Unit + browser

```sh
npm test                  # 96 Node-mode tests
npm run test:browser      # 2 browser tests in real Chromium (Playwright)
```

### Wallet (no network)

```sh
cp .env.test.example .env.test    # fill in the test wallet vars
npm run smoke:wallet
```

Confirms LK_API_KEY/LK_API_SECRET sign + verify a chat-token JWT locally.

### Stage D integration matrix (real mesh)

Run all scenarios with `npm run smoke:all`. Three of them (`offline-fallback`, `push-gating`, `crash-recovery`) require the deployed nodes to POST back to the mock's webhook endpoint, so the mock must be started with a public tunnel: `cd ../secure-chat-mock && TUNNEL=1 npm start` (uses `cloudflared` quick tunnels — no auth needed, install via `brew install cloudflared`).

| Smoke | What it covers |
|---|---|
| `smoke:auth` | Chat-token JWT happy path + reject expired / wrong typ / unregistered signer |
| `smoke:transport` | Same-node alice→bob round-trip, low-level WS + `chatSendResult` |
| `smoke:cross-node` | alice + bob on distinct nodes; gossipsub-routed delivery + ACK |
| `smoke:fanout` | bob with 3 devices; alice's status walks `sent → delivered → deliveredAll` |
| `smoke:offline-fallback` | bob offline → mock stores envelope → bob reconnects → decrypts |
| `smoke:push-gating` | push=false when sibling device live; push=true when all offline |
| `smoke:ephemeral` | typing event drops on offline-fallback path (no mock POST) |
| `smoke:edit-delete-authz` | edits/deletes from non-author dropped; legitimate ones applied |
| `smoke:read-typing` | read watermark, typing throttle (3s), auto-stop (5s) |
| `smoke:fwd-compat` | unknown content type / `v: 2` silently dropped; v1 keeps flowing |
| `smoke:crash-recovery` | mid-pull crash → reconnect → idempotent dedupe; `message` fires once |
| `smoke:node-failure` | client-side WS drop → auto-reconnect → resume send/receive |
| `smoke:idle` | 50 idle WS connections produce zero offline-fallback / pushes (mesh-only presence) |
| `smoke:block` | claim_all filters; offline-fallback dropped:true; unblock restores |
| `smoke:history-reload` | `getHistory` survives disconnect+reconnect with same store; fresh = empty |
| `smoke:multi-device-sender` | alice with 2 devices; bidirectional fanout; alice-A's send self-echoes to alice-B |
| `smoke:self-echo` | text/edit/delete/read all sync to other own devices |
| `smoke:peer-new-device` | `peerNewDevice` fires once on new bob device; subsequent fanout includes it |
| `smoke:otk-exhaustion` | OTK pool drains → claim returns `oneTimeKey: null` → fallback prekey works; auto-topup refills on reconnect |
| `smoke:read-receipts-gating` | `setReadReceiptsEnabled(false)` suppresses outbound `read`; re-enable restores |

To skip Solana discovery and point at a specific node (local dev or a known test node), set `CHAT_NODE_WS_URL_OVERRIDE=wss://node.example` in the **mock's** environment before starting it.

## License

Apache-2.0
