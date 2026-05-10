// smoke:multi-device-sender — verifies bidirectional multi-device flow
// from the SENDER side (alice with 2 simultaneous devices). Earlier
// smoke-fanout covers the symmetric case (alice→bob with bob having
// N devices); this smoke focuses on what's new when alice herself
// has multiple live devices:
//
//   1. claim_all for alice (called by bob) returns both alice devices.
//   2. bob's sendText fans out → both alice-A and alice-B decrypt.
//   3. alice-A's send is delivered to bob (no regression vs single-device).
//   4. alice-B's send is also delivered to bob (separate Olm session).
//
// Self-echo: alice-A's outbound is also encrypted to alice-B (filtered:
// not back to alice-A) wrapped in a `selfEcho` content event so alice-B
// observes the message as if it had sent it. This matches Signal's
// "sync messages" model.

import { runSmoke, check, sdkConnect, resetMock, delay, waitFor } from "./_smoke-helpers.js";

await runSmoke("smoke:multi-device-sender", async () => {
  await resetMock();

  const aliceUser = `alice-mds-${Date.now()}`;
  const bobUser = `bob-mds-${Date.now()}`;

  // Two alice devices live concurrently.
  const aliceA = await sdkConnect(aliceUser, { deviceId: "alice-A" });
  const aliceB = await sdkConnect(aliceUser, { deviceId: "alice-B" });
  const bob = await sdkConnect(bobUser);

  const aliceAReceived: string[] = [];
  const aliceBReceived: string[] = [];
  const bobReceived: string[] = [];
  aliceA.sdk.on("message", (e) => {
    if (e.peerUserId === bobUser) aliceAReceived.push(e.message.text ?? "");
  });
  aliceB.sdk.on("message", (e) => {
    if (e.peerUserId === bobUser) aliceBReceived.push(e.message.text ?? "");
  });
  bob.sdk.on("message", (e) => {
    if (e.peerUserId === aliceUser) bobReceived.push(e.message.text ?? "");
  });

  // ── 1+2: bob sends → both alice devices receive (claim_all-driven fanout).
  await bob.sdk.sendText(aliceUser, "to-both-alice-devices");
  await waitFor(() => (aliceAReceived.length >= 1 && aliceBReceived.length >= 1 ? true : undefined),
    8_000, "both alice devices to receive");

  check("alice-A received bob's send", aliceAReceived.includes("to-both-alice-devices"),
    `aliceA: ${JSON.stringify(aliceAReceived)}`);
  check("alice-B received bob's send", aliceBReceived.includes("to-both-alice-devices"),
    `aliceB: ${JSON.stringify(aliceBReceived)}`);

  // ── 3: alice-A → bob (bob receives on its single device).
  await aliceA.sdk.sendText(bobUser, "from-alice-A");
  await waitFor(() => (bobReceived.includes("from-alice-A") ? true : undefined),
    5_000, "bob to receive from alice-A");
  check("bob received alice-A's send", bobReceived.includes("from-alice-A"),
    `bob: ${JSON.stringify(bobReceived)}`);

  // ── 4: alice-B → bob (separate Olm session, also delivered).
  await aliceB.sdk.sendText(bobUser, "from-alice-B");
  await waitFor(() => (bobReceived.includes("from-alice-B") ? true : undefined),
    5_000, "bob to receive from alice-B");
  check("bob received alice-B's send", bobReceived.includes("from-alice-B"),
    `bob: ${JSON.stringify(bobReceived)}`);

  // ── 5: self-echo — alice-A's outbound to bob also lands at alice-B
  //       via a wrapped `selfEcho` envelope. alice-B's `message` event
  //       fires for the original peer (bob) with senderUserId=self,
  //       so the UI can render it as outbound on the second screen.
  await waitFor(
    () => (aliceBReceived.includes("from-alice-A") ? true : undefined),
    8_000, "alice-B to receive self-echo of alice-A's send",
  );
  check(
    "self-echo: alice-B sees alice-A's outbound",
    aliceBReceived.includes("from-alice-A"),
    `aliceB events for bob peer: ${JSON.stringify(aliceBReceived)}`,
  );

  await Promise.all([
    aliceA.sdk.disconnect(),
    aliceB.sdk.disconnect(),
    bob.sdk.disconnect(),
  ]);
});
