// smoke:delivery-ack-tab-close — verifies the new at-least-once semantics
// fix the optimistic-StatusLive bug. The SDK's MessageStatus enum
// collapses "live" and "stored" both to "sent" so we can't distinguish
// them at the API surface. Instead we observe the side effect on the
// mock backend: the new node fires the webhook fallback when no client
// ack arrives; the OLD node returns optimistic StatusLive immediately
// and no webhook fires.
//
// Scenario:
//   1. A and B both online.
//   2. B's WS drops abruptly.
//   3. Within a few hundred ms (before B's TCP close fully propagates
//      to the deployed node), A sends to B.
//   4. The node tries to deliver; on the NEW node it waits for B's
//      chatEnvelopeAck. None arrives → 2s timeout → webhook fires.
//   5. We assert the mock saw exactly one envelope for B.
//
// **Requires node v1.1+ AND a reachable webhook** (TUNNEL=1 mock).
// Against the OLD node this smoke will fail (mock receives 0 envelopes).
// That failure is the expected signal during rollout.

import {
  check,
  delay,
  getMockState,
  requireReachableWebhook,
  runSmoke,
  sdkConnect,
  waitFor,
} from "./_smoke-helpers.js";

await requireReachableWebhook("smoke:delivery-ack-tab-close");

await runSmoke("smoke:delivery-ack-tab-close", async () => {
  const ts = Date.now();
  const aliceUser = `alice-tc-${ts}`;
  const bobUser = `bob-tc-${ts}`;

  const alice = await sdkConnect(aliceUser);
  const bob = await sdkConnect(bobUser);

  // Drop B's WS but DO NOT clear the deployed node's presence cache —
  // the cache lags a bit behind the TCP close. So when A sends ~150ms
  // later, the node still thinks B is local and writes to a half-closed
  // socket. The new node then waits for B's chatEnvelopeAck (never
  // arrives) → falls back to webhook.
  await bob.sdk.disconnect();
  await delay(150);

  await alice.sdk.sendText(bobUser, "tab-close-test");

  // The new node's fallbackTimeout is 2s. Allow webhook POST to land at
  // the mock (cloudflared adds ~half a second).
  await waitFor(async () => {
    const state = await getMockState();
    const bobQueue = state.envelopes_by_recipient.find((e) => e.key.includes(bobUser));
    return bobQueue && bobQueue.count > 0 ? true : undefined;
  }, 6_000, "mock to receive webhook envelope for B");

  const state = await getMockState();
  const bobQueue = state.envelopes_by_recipient.find((e) => e.key.includes(bobUser));
  check("1.1 mock has webhook-stored envelope for B (proves no optimistic StatusLive)",
    bobQueue !== undefined && bobQueue.count === 1,
    `bobQueue=${JSON.stringify(bobQueue)}`);
  check("1.2 push flag set (B's only device is offline)",
    state.push_events.some((p) => p.user_id.includes(bobUser)),
    `push_events=${JSON.stringify(state.push_events)}`);

  await alice.sdk.disconnect();
});
