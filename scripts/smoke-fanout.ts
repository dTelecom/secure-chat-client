// smoke:fanout — alice sends one text to bob who has 3 devices online.
// Verifies all 3 receive AND alice's status walks pending → sent →
// delivered → deliveredAll as `received` events come back.

import { runSmoke, check, sdkConnect, waitFor, delay } from "./_smoke-helpers.js";

await runSmoke("smoke:fanout", async () => {
  const alice = await sdkConnect("alice-fanout");

  const bobUserId = "bob-fanout";
  const bob1 = await sdkConnect(bobUserId, { deviceId: "bob-phone-fanout" });
  const bob2 = await sdkConnect(bobUserId, { deviceId: "bob-laptop-fanout" });
  const bob3 = await sdkConnect(bobUserId, { deviceId: "bob-tablet-fanout" });

  const received1: string[] = [];
  const received2: string[] = [];
  const received3: string[] = [];
  bob1.sdk.on("message", (e) => received1.push(e.message.text));
  bob2.sdk.on("message", (e) => received2.push(e.message.text));
  bob3.sdk.on("message", (e) => received3.push(e.message.text));

  let aliceStatus: string | undefined;
  alice.sdk.on("statusChange", (e) => {
    if (e.peerUserId === bobUserId) aliceStatus = e.status;
  });

  const messageId = await alice.sdk.sendText(bobUserId, "hello, all three");

  await waitFor(() => (received1.length && received2.length && received3.length ? true : undefined),
    10_000,
    "all three bob devices to receive",
  );

  check("bob-phone received", received1[0] === "hello, all three");
  check("bob-laptop received", received2[0] === "hello, all three");
  check("bob-tablet received", received3[0] === "hello, all three");

  // Each device auto-emits a `received` event (batched ~500ms). Wait long
  // enough for them all to come back.
  await delay(2000);
  check("alice status walked to deliveredAll", aliceStatus === "deliveredAll" || aliceStatus === "read",
    `got ${aliceStatus}`);

  void messageId;
  await Promise.all([alice.sdk.disconnect(), bob1.sdk.disconnect(), bob2.sdk.disconnect(), bob3.sdk.disconnect()]);
});
