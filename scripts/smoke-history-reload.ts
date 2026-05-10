// smoke:history-reload — verifies that getHistory returns prior messages
// from the local store after disconnect + reconnect with the SAME store.
// Local plaintext is the only source of truth (the server only stores
// ciphertext envelopes pending delivery), so a fresh-store reconnect
// MUST start with empty history.
//
//   step 1: alice + bob exchange 4 messages.
//   step 2: bob disconnects.
//   step 3: bob reconnects with the SAME MemoryKVStore →
//           getHistory returns the same 4 messages, ordered.
//   step 4: bob reconnects with a FRESH store (simulating new install)
//           → getHistory returns []. Ciphertext history isn't
//           re-streamed; only newly-delivered messages would appear.

import { runSmoke, check, sdkConnect, resetMock, delay, waitFor } from "./_smoke-helpers.js";

await runSmoke("smoke:history-reload", async () => {
  await resetMock();

  const aliceUser = `alice-history-${Date.now()}`;
  const bobUser = `bob-history-${Date.now()}`;

  const bob = await sdkConnect(bobUser);
  const alice = await sdkConnect(aliceUser);

  const bobReceived: string[] = [];
  bob.sdk.on("message", (e) => {
    if (e.peerUserId === aliceUser) bobReceived.push(e.message.text ?? "");
  });

  // ── step 1: 4-message exchange (alice→bob, bob→alice, alice→bob, alice→bob).
  await alice.sdk.sendText(bobUser, "h1");
  await waitFor(() => (bobReceived.length >= 1 ? true : undefined), 5_000, "bob h1");

  await bob.sdk.sendText(aliceUser, "h2");
  await delay(1_000);

  await alice.sdk.sendText(bobUser, "h3");
  await alice.sdk.sendText(bobUser, "h4");
  await waitFor(() => (bobReceived.length >= 3 ? true : undefined), 5_000, "bob h3+h4");

  const beforeDisconnect = await bob.sdk.getHistory(aliceUser);
  check(
    "pre-disconnect: bob has 4 messages with alice",
    beforeDisconnect.length === 4,
    `len=${beforeDisconnect.length}, ids=${beforeDisconnect.map((m) => m.id).join(",")}`,
  );

  // ── step 2: disconnect, hold the store.
  await bob.sdk.disconnect();
  await delay(300);

  // ── step 3: reconnect with same store → history persists.
  const bob2 = await sdkConnect(bobUser, { deviceId: bob.deviceId, store: bob.store });
  const reloaded = await bob2.sdk.getHistory(aliceUser);
  check(
    "reconnect (same store): same 4 messages returned",
    reloaded.length === 4,
    `len=${reloaded.length}, ids=${reloaded.map((m) => m.id).join(",")}`,
  );
  const beforeIds = beforeDisconnect.map((m) => m.id).join(",");
  const reloadedIds = reloaded.map((m) => m.id).join(",");
  check(
    "reconnect: ids + ordering preserved",
    beforeIds === reloadedIds,
    `before=${beforeIds} after=${reloadedIds}`,
  );

  // Texts also intact.
  const reloadedTexts = reloaded.map((m) => m.text);
  check(
    "reconnect: texts intact",
    reloadedTexts.includes("h1") && reloadedTexts.includes("h2") &&
      reloadedTexts.includes("h3") && reloadedTexts.includes("h4"),
    `texts=${JSON.stringify(reloadedTexts)}`,
  );

  await bob2.sdk.disconnect();
  await delay(300);

  // ── step 4: reconnect with FRESH store → empty history.
  const bobNewInstall = await sdkConnect(bobUser);
  const cold = await bobNewInstall.sdk.getHistory(aliceUser);
  check("fresh store (new install): history is empty", cold.length === 0,
    `len=${cold.length}`);

  await Promise.all([alice.sdk.disconnect(), bobNewInstall.sdk.disconnect()]);
});
