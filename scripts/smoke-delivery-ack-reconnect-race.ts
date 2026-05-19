// smoke:delivery-ack-reconnect-race — verify the new node's retry loop
// catches a recipient that reconnects mid-flow without falling back to
// webhook.
//
// Scenario:
//   1. A and B both online.
//   2. B disconnects.
//   3. A sends.
//   4. B reconnects within ~500-800ms (faster than the first retry tick
//      that would publish on B's topic). The retry publish lands on B's
//      new subscription, B decrypts + acks, A's send returns StatusLive
//      (no webhook fired).
//
// Assertion: mock has ZERO webhook envelopes for B AND B's history has
// the message.
//
// **Requires node v1.1+** (retry loop is new). Webhook not required —
// the test passes without ever touching it.

import {
  check,
  delay,
  getMockState,
  runSmoke,
  sdkConnect,
  waitFor,
} from "./_smoke-helpers.js";

await runSmoke("smoke:delivery-ack-reconnect-race", async () => {
  const ts = Date.now();
  const aliceUser = `alice-rr-${ts}`;
  const bobUser = `bob-rr-${ts}`;

  const alice = await sdkConnect(aliceUser);
  const bob = await sdkConnect(bobUser);
  const bobStore = bob.store;

  // Drop B and immediately send. B is offline for ~700ms; the node's
  // retry tick (500ms) republishes on B's topic; by ~800ms B has
  // reconnected and the next retry lands.
  await bob.sdk.disconnect();
  await delay(50);

  await alice.sdk.sendText(bobUser, "reconnect-race-msg");

  // Reconnect B around the second retry tick.
  await delay(700);
  const bob2 = await sdkConnect(bobUser, { store: bobStore });

  // Allow time for the retry to land on B2 and for B2 to ack.
  await waitFor(async () => {
    const h = await bob2.sdk.getHistory(aliceUser, { limit: 10 });
    return h.some((m) => m.text === "reconnect-race-msg") ? true : undefined;
  }, 5_000, "B2 to receive reconnect-race-msg");

  // Critical assertion: webhook should NOT have fired. The retry caught
  // B's reconnect within the 2s window.
  await delay(500); // small grace period for any in-flight webhook POST
  const state = await getMockState();
  const bobQueue = state.envelopes_by_recipient.find((e) => e.key.includes(bobUser));
  check("1.1 B (reconnected) received the message", true);
  check("1.2 mock has NO webhook envelope for B (retry caught the reconnect)",
    bobQueue === undefined || bobQueue.count === 0,
    `bobQueue=${JSON.stringify(bobQueue)}`);

  await alice.sdk.disconnect();
  await bob2.sdk.disconnect();
});
