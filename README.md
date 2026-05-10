# @dtelecom/secure-chat-client

TypeScript SDK for end-to-end encrypted 1:1 chat over the dTelecom mesh. Olm via vodozemac, fanout multi-device, multi-device sync (Signal-style), self-echo, offline-fallback delivery, content-protocol forward compat.

## Status

v0.1.0 — feature complete.

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
  apiBaseURL: "https://your-tenant-backend.example",
  fetchChatToken: async (deviceId) => {
    // Call your tenant backend; it should mint a chat-token JWT
    // signed with the tenant wallet (Ed25519 via Solana registry).
    const r = await fetch("/api/chat/token", {
      method: "POST",
      body: JSON.stringify({ deviceId }),
    });
    return r.json(); // { chatToken, chatNodeWsUrl, expiresAt }
  },
});

chat.on("message", (e) => console.log(e.peerUserId, "→", e.message.text));
chat.on("messageEdited", (e) => /* ... */);
chat.on("messageDeleted", (e) => /* ... */);
chat.on("statusChange", (e) => /* sent → delivered → deliveredAll → read */);
chat.on("typing", (e) => /* started / stopped */);
chat.on("readReceipt", (e) => /* upTo a given message id */);
chat.on("peerNewDevice", (e) => /* TOFU UI */);

await chat.sendText("bob-user-id", "hi bob");
await chat.editMessage("bob-user-id", messageId, "edited");
await chat.deleteMessage("bob-user-id", messageId);
await chat.markRead("bob-user-id", messageId);
chat.setTyping("bob-user-id", true);

const history = await chat.getHistory("bob-user-id", { limit: 50 });

await chat.blockUser("alice");
await chat.unblockUser("alice");
const blocked = await chat.getBlockedUsers();

await chat.setReadReceiptsEnabled(false);
await chat.markPeerDeviceVerified("bob", "bob-phone", true);
const fingerprint = await chat.getPeerDeviceFingerprint("bob", "bob-phone");
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
