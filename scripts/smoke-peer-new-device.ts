// smoke:peer-new-device — covers chat-wire-contract.md §17 prekey-
// discovery. Mid-chat, bob registers a SECOND device. Verify:
//
//   1. The second device sends a text → alice's SDK decrypts (creates
//      an inbound session from the prekey envelope) AND fires the
//      `peerNewDevice` event exactly once with the new device's id.
//   2. Alice's NEXT send fanouts to BOTH bob devices (the new device
//      now appears in claim_all results — no longer "unknown").
//   3. The event is idempotent — repeated messages from bob-B do not
//      fire `peerNewDevice` again.

import { runSmoke, check, sdkConnect, resetMock, delay, waitFor } from "./_smoke-helpers.js";

await runSmoke("smoke:peer-new-device", async () => {
  await resetMock();

  const aliceUser = `alice-pnd-${Date.now()}`;
  const bobUser = `bob-pnd-${Date.now()}`;

  const alice = await sdkConnect(aliceUser);
  const bobA = await sdkConnect(bobUser, { deviceId: "bob-A" });

  const aliceReceived: { from: string; text: string }[] = [];
  const newDeviceEvents: { peerUserId: string; peerDeviceId: string }[] = [];
  alice.sdk.on("message", (e) => {
    if (e.peerUserId === bobUser) {
      aliceReceived.push({ from: e.peerDeviceId, text: e.message.text ?? "" });
    }
  });
  alice.sdk.on("peerNewDevice", (e) => {
    newDeviceEvents.push({ peerUserId: e.peerUserId, peerDeviceId: e.peerDeviceId });
  });

  // ── warmup: alice ↔ bob-A so alice's local peerDevices cache holds bob-A.
  await alice.sdk.sendText(bobUser, "warmup");
  await delay(1_000);
  await bobA.sdk.sendText(aliceUser, "warmup-reply");
  await waitFor(() => (aliceReceived.length >= 1 ? true : undefined),
    5_000, "alice to receive warmup-reply");

  // No new-device events yet (bob-A was known before any decrypt).
  // The first decrypted message from bob-A IS technically a "first-seen"
  // at the cache level, so accept either 0 or 1 here — but pin it so
  // a second event for bob-A would surface as a regression.
  const eventsAfterWarmup = newDeviceEvents.length;
  check("warmup: peerNewDevice fired at most once for bob-A",
    eventsAfterWarmup <= 1 && newDeviceEvents.every((e) => e.peerDeviceId === "bob-A"),
    `events: ${JSON.stringify(newDeviceEvents)}`);

  // ── new device joins mid-chat.
  const bobB = await sdkConnect(bobUser, { deviceId: "bob-B" });
  await bobB.sdk.sendText(aliceUser, "hello-from-second-device");

  await waitFor(
    () => (aliceReceived.find((m) => m.text === "hello-from-second-device") ? true : undefined),
    8_000,
    "alice to decrypt from bob-B",
  );
  await delay(500); // let peerNewDevice dispatch run

  const bobBEvents = newDeviceEvents.filter((e) => e.peerDeviceId === "bob-B");
  check("peerNewDevice fired exactly once for bob-B", bobBEvents.length === 1,
    `bob-B events: ${bobBEvents.length}, all events: ${JSON.stringify(newDeviceEvents)}`);

  // ── alice's next send must fanout to BOTH bob devices.
  const bobAReceived: string[] = [];
  const bobBReceived: string[] = [];
  bobA.sdk.on("message", (e) => {
    if (e.peerUserId === aliceUser) bobAReceived.push(e.message.text ?? "");
  });
  bobB.sdk.on("message", (e) => {
    if (e.peerUserId === aliceUser) bobBReceived.push(e.message.text ?? "");
  });

  await alice.sdk.sendText(bobUser, "after-discovery-fanout");
  await waitFor(
    () => (bobAReceived.includes("after-discovery-fanout") &&
           bobBReceived.includes("after-discovery-fanout")) ? true : undefined,
    8_000, "fanout to reach both bob devices",
  );
  check("alice's next send reaches bob-A", bobAReceived.includes("after-discovery-fanout"));
  check("alice's next send reaches bob-B", bobBReceived.includes("after-discovery-fanout"));

  // ── idempotent: a second message from bob-B does NOT re-fire peerNewDevice.
  const eventCountBefore = newDeviceEvents.length;
  await bobB.sdk.sendText(aliceUser, "second-from-bob-B");
  await waitFor(
    () => (aliceReceived.find((m) => m.text === "second-from-bob-B") ? true : undefined),
    5_000, "alice to receive second from bob-B",
  );
  await delay(500);
  check("peerNewDevice is idempotent (no duplicate fire on repeat msg)",
    newDeviceEvents.length === eventCountBefore,
    `before: ${eventCountBefore}, after: ${newDeviceEvents.length}`);

  await Promise.all([
    alice.sdk.disconnect(),
    bobA.sdk.disconnect(),
    bobB.sdk.disconnect(),
  ]);
});
