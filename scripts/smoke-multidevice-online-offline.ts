// smoke:multidevice-online-offline — end-to-end coverage of the multi-
// device × online/offline matrix, against the mock backend + real Olm
// crypto.
//
// Scenarios (each runs as a sequential phase sharing setup):
//
//   1. baseline — alice ↔ bob-A handshake when both online
//   2. silent-new-device → alice sends — bob-B added without sending; the
//      background-discovery + catch-up envelope path delivers alice's
//      next message to BOTH bob devices
//   3. bob-A sends → alice + bob-B (via self-echo) both receive
//   4. bob-B sends → alice + bob-A (via self-echo) both receive
//   5. alice offline + bob-B sends → alice's offline envelope queue
//      accumulates → on reconnect alice receives
//   6. all bob devices offline + alice sends → each bob device receives
//      via its own offline queue drain on respective reconnects
//   7. alice offline + bob adds bob-C silently + alice reconnects + alice
//      sends → reconnect rebuilds bundleCache from backend → fanouts to
//      bob-A + bob-B + bob-C without needing the catch-up path
//
// What "real messages" means here:
//   - OlmCryptoAdapter (vodozemac WASM) does actual prekey + ratchet
//   - HttpClient hits the mock at localhost:8787 for /keys/* + /envelopes/*
//   - WsClient holds a live socket per device session; offline = WS closed
//   - Mock routes envelopes through its in-memory queue exactly the way
//     the real dtelecom node mesh would

import {
  runSmoke,
  check,
  sdkConnect,
  resetMock,
  delay,
  waitFor,
  getMockState,
  type SdkSide,
} from "./_smoke-helpers.js";

interface MessageLog {
  // (peerUserId, peerDeviceId, text) tuples, oldest first
  received: { peer: string; from: string; text: string }[];
}

// Attaches a listener to an SDK so the smoke can assert later who saw what.
// Returns the log so the caller can inspect / filter.
function track(side: SdkSide): MessageLog {
  const log: MessageLog = { received: [] };
  side.sdk.on("message", (e) => {
    log.received.push({
      peer: e.peerUserId,
      from: e.peerDeviceId,
      text: e.message.text ?? "",
    });
  });
  return log;
}

// Helper that pulls (just the text values) for messages received from a
// specific peer user. Useful for "expected texts arrived" assertions.
function textsFromUser(log: MessageLog, peerUser: string): string[] {
  return log.received.filter((m) => m.peer === peerUser).map((m) => m.text);
}

// For offline-drain assertions: drainPending fires `message` events
// synchronously during connect() — BEFORE the smoke attaches its
// listener. The store, however, is written before each dispatch. So
// poll the store to determine whether a message was decrypted, race-
// free with respect to listener-attach timing.
async function textsInHistory(side: SdkSide, peerUser: string): Promise<string[]> {
  const msgs = await side.sdk.getHistory(peerUser, { limit: 100 });
  return msgs.map((m) => m.text ?? "");
}

await runSmoke("smoke:multidevice-online-offline", async () => {
  await resetMock();

  // Tag user IDs by timestamp so re-runs against a long-lived mock don't
  // collide on prior state.
  const t = Date.now();
  const aliceUser = `alice-mdoo-${t}`;
  const bobUser = `bob-mdoo-${t}`;

  // ── Scenario 1 ── baseline: A ↔ B-A while both online ──────────────────

  console.log("\n--- 1. baseline ---");
  const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
  const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
  const aliceLog = track(alice);
  const bobALog = track(bobA);

  await alice.sdk.sendText(bobUser, "s1-hello-from-alice");
  await waitFor(
    () => (textsFromUser(bobALog, aliceUser).includes("s1-hello-from-alice") ? true : undefined),
    5_000, "bob-A to receive s1-hello-from-alice",
  );
  check("1.1 bob-A receives alice's first message", true);

  await bobA.sdk.sendText(aliceUser, "s1-hi-from-bobA");
  await waitFor(
    () => (textsFromUser(aliceLog, bobUser).includes("s1-hi-from-bobA") ? true : undefined),
    5_000, "alice to receive s1-hi-from-bobA",
  );
  check("1.2 alice receives bob-A's reply", true);

  // ── Scenario 2 ── A on, B on, B-2 added silently, A sends ──────────────
  //                  The new 0.10.0 catch-up path: alice's send reaches
  //                  bob-A immediately AND bob-B via background discovery.

  console.log("\n--- 2. silent-new-device + alice sends ---");
  const bobB = await sdkConnect(bobUser, { deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });
  const bobBLog = track(bobB);
  // bob-B is online now (WS open, key bundle registered) but has NOT sent
  // anything yet — alice's reactive `maybeAnnouncePeerDevice` has not fired.
  // The catch-up path is the only thing that can deliver alice's next send
  // to bob-B before bob-B sends.

  await alice.sdk.sendText(bobUser, "s2-silent-fanout");
  await waitFor(
    () => (textsFromUser(bobALog, aliceUser).includes("s2-silent-fanout") ? true : undefined),
    5_000, "bob-A to receive s2-silent-fanout",
  );
  // bob-B receives via catch-up. The catch-up is rate-limited (30s floor)
  // and runs in parallel with the original send, so allow a bit longer.
  await waitFor(
    () => (textsFromUser(bobBLog, aliceUser).includes("s2-silent-fanout") ? true : undefined),
    8_000, "bob-B to receive s2-silent-fanout via catch-up",
  );
  check("2.1 bob-A receives alice's send (immediate fanout)", true);
  check("2.2 bob-B receives alice's send (background-discovery catch-up)", true);

  // ── Scenario 3 ── bob-A sends → alice + bob-B (self-echo) ──────────────

  // Self-echo events surface in the sibling's `message` listener with
  // peerUserId === ORIGINAL peer (alice), senderUserId === self. The UI
  // shows them in the alice-conversation authored by self. So we assert
  // them on textsFromUser(<sibling>, aliceUser), NOT (<sibling>, bobUser).

  console.log("\n--- 3. bob-A sends → alice + bob-B self-echo ---");
  await bobA.sdk.sendText(aliceUser, "s3-from-bobA");
  await waitFor(
    () => (textsFromUser(aliceLog, bobUser).includes("s3-from-bobA") ? true : undefined),
    5_000, "alice to receive s3-from-bobA",
  );
  await waitFor(
    () => (textsFromUser(bobBLog, aliceUser).includes("s3-from-bobA") ? true : undefined),
    8_000, "bob-B to self-echo s3-from-bobA",
  );
  check("3.1 alice receives bob-A's send", true);
  check("3.2 bob-B receives bob-A's send via self-echo", true);

  // ── Scenario 4 ── bob-B sends → alice + bob-A (self-echo) ──────────────

  console.log("\n--- 4. bob-B sends → alice + bob-A self-echo ---");
  await bobB.sdk.sendText(aliceUser, "s4-from-bobB");
  await waitFor(
    () => (textsFromUser(aliceLog, bobUser).includes("s4-from-bobB") ? true : undefined),
    5_000, "alice to receive s4-from-bobB",
  );
  await waitFor(
    () => (textsFromUser(bobALog, aliceUser).includes("s4-from-bobB") ? true : undefined),
    8_000, "bob-A to self-echo s4-from-bobB",
  );
  check("4.1 alice receives bob-B's send", true);
  check("4.2 bob-A receives bob-B's send via self-echo", true);

  // ── Scenario 5 ── alice offline + bob-B sends → alice reconnects ──────
  //                  Mock backend writes to alice's offline envelope queue
  //                  while her WS is closed; on reconnect she drains it.

  console.log("\n--- 5. alice offline + bob-B sends → alice reconnects ---");
  await alice.sdk.disconnect();
  // give the WS close a moment to land on the mock's presence table
  await delay(300);

  await bobB.sdk.sendText(aliceUser, "s5-while-alice-offline");
  // While alice's WS is down, the mock queues into /envelopes/pending
  // for alice's device. bob-A still receives live via self-echo.
  await waitFor(
    () => (textsFromUser(bobALog, aliceUser).includes("s5-while-alice-offline") ? true : undefined),
    8_000, "bob-A to self-echo s5 even though alice is offline",
  );
  check("5.1 bob-A self-echoes s5 while alice is offline", true);

  // Diagnostic: confirm an envelope actually landed in the mock's queue
  // for alice. If this is 0, the deployed node could not reach the mock's
  // chat_webhook_url (it points at localhost by default) — meaning
  // scenarios 5–7 (anything that depends on offline delivery) cannot run
  // without a public tunnel for the mock. See requireReachableWebhook.
  {
    const s = await getMockState();
    const aliceEnvelopes = s.envelopes_by_recipient.find((e) => e.key.includes(aliceUser));
    if (!aliceEnvelopes || aliceEnvelopes.count === 0) {
      console.log(
        `\n[skip] scenarios 5–7 require a publicly-reachable mock webhook so\n` +
        `the deployed dtelecom node can POST offline envelopes back to\n` +
        `localhost. Expose the mock via ngrok and set CHAT_WEBHOOK_URL on the\n` +
        `mock to the public URL. Online scenarios (1–4) passed; exiting clean.\n`,
      );
      await Promise.all([alice.sdk.disconnect(), bobA.sdk.disconnect(), bobB.sdk.disconnect()]);
      return;
    }
  }

  // Reconnect alice using the SAME store + deviceId so Olm sessions
  // survive and the offline queue drains correctly.
  const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });
  // Use the message-store, not the live event log — drainPending may
  // have fired the event before any listener could attach. See
  // textsInHistory rationale above.
  await waitFor(
    async () => ((await textsInHistory(alice2, bobUser)).includes("s5-while-alice-offline") ? true : undefined),
    10_000, "alice (reconnected) to drain s5-while-alice-offline",
  );
  check("5.2 alice (reconnected) receives s5 from offline queue", true);

  // alice2 batches a `received` ack for s5 (500ms timer). Wait long
  // enough that the ack flushes and is delivered to BOTH bob devices
  // via live WS, BEFORE we disconnect them for scenario 6. Otherwise
  // the ack races bob's disconnect and the node may mis-route s6 to a
  // device whose WS is closing — silently dropping the s6 envelope.
  await delay(2000);

  // ── Scenario 6 ── A on, both bob devices offline, A sends ──────────────
  //                  Each bob device receives via its own offline queue
  //                  drain on respective reconnects.

  console.log("\n--- 6. both bob devices offline + alice sends ---");
  await bobA.sdk.disconnect();
  await bobB.sdk.disconnect();
  // Long enough that the deployed node's presence cache marks both bob
  // devices offline before alice2 sends s6 — otherwise the node tries
  // WS delivery to a half-closed connection and the s6 envelope drops
  // silently (no webhook fallback).
  await delay(1500);

  await alice2.sdk.sendText(bobUser, "s6-while-bob-all-offline");
  // Wait until the webhook POSTs for both bob devices have landed in
  // the mock queue. Connecting bob's reconnect-SDK before that lets
  // its drainPending hit an empty queue and miss s6.
  await waitFor(async () => {
    const s = await getMockState();
    const bobQueues = s.envelopes_by_recipient.filter((e) => e.key.includes(bobUser));
    const totalCount = bobQueues.reduce((a, e) => a + e.count, 0);
    return bobQueues.length >= 2 && totalCount >= 2 ? true : undefined;
  }, 15_000, "both bob devices to receive s6 envelope in mock queue");

  const bobA2 = await sdkConnect(bobUser, { store: bobA.store, backgroundDiscoveryFloorMs: 0 });
  await waitFor(
    async () => ((await textsInHistory(bobA2, aliceUser)).includes("s6-while-bob-all-offline") ? true : undefined),
    10_000, "bob-A (reconnected) to drain s6",
  );
  check("6.1 bob-A reconnects and drains s6 from offline queue", true);

  const bobB2 = await sdkConnect(bobUser, { store: bobB.store, backgroundDiscoveryFloorMs: 0 });
  await waitFor(
    async () => ((await textsInHistory(bobB2, aliceUser)).includes("s6-while-bob-all-offline") ? true : undefined),
    10_000, "bob-B (reconnected) to drain s6",
  );
  check("6.2 bob-B reconnects and drains s6 from offline queue", true);

  // ── Scenario 7 ── alice offline + bob silently adds bob-C + alice
  //                  reconnects + alice sends → reaches A, B, C ──────────
  //                  Verifies that reconnect-then-send picks up arbitrarily
  //                  many devices added during the offline window. Also
  //                  exercises the mixed-msgType fanout path: alice3's
  //                  send produces "normal" ciphertext for existing
  //                  sessions (bobA, bobB) AND "prekey" ciphertext for
  //                  the new device (bobC). The SDK must group these
  //                  into separate chatSend frames per msgType — sending
  //                  all targets in one frame with a single msgType
  //                  would cause the recipients whose actual ciphertext
  //                  doesn't match the frame-level msgType to silently
  //                  fail to decrypt.

  console.log("\n--- 7. alice offline + bob adds bob-C + alice reconnects ---");
  await alice2.sdk.disconnect();
  await delay(300);

  const bobC = await sdkConnect(bobUser, { deviceId: "bob-C", backgroundDiscoveryFloorMs: 0 });
  // bob-C is online but silent — registers a bundle, that's it.

  // alice reconnects after bob-C is in the registry.
  const alice3 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });
  await delay(1000); // settle alice3's WS + drainPending before send

  await alice3.sdk.sendText(bobUser, "s7-after-reconnect-with-bobC");

  // All three bob devices must receive — bob-A + bob-B via their fresh
  // post-reconnect WS (existing-session normal-type ciphertext), bob-C
  // via its first-ever delivery from alice (prekey-type ciphertext).
  await waitFor(
    async () => ((await textsInHistory(bobA2, aliceUser)).includes("s7-after-reconnect-with-bobC") ? true : undefined),
    10_000, "bob-A2 to receive s7",
  );
  await waitFor(
    async () => ((await textsInHistory(bobB2, aliceUser)).includes("s7-after-reconnect-with-bobC") ? true : undefined),
    10_000, "bob-B2 to receive s7",
  );
  await waitFor(
    async () => ((await textsInHistory(bobC, aliceUser)).includes("s7-after-reconnect-with-bobC") ? true : undefined),
    10_000, "bob-C to receive s7",
  );
  check("7.1 bob-A receives s7 via existing-session normal-type ciphertext", true);
  check("7.2 bob-B receives s7 via existing-session normal-type ciphertext", true);
  check("7.3 bob-C receives s7 via fresh-session prekey-type ciphertext", true);

  // ── Cross-cutting negative checks ──────────────────────────────────────
  // Alice should never have stored any of her OWN sends as inbound
  // messages. The mesh filters our-user-our-device frames before they hit
  // the SDK; if any leaked, the store would have alice's own texts under
  // peerUserId === aliceUser. Query the store (race-free, see scenario
  // 5's textsInHistory rationale) — listener-based collection would
  // miss events fired during connect().
  const aliceSentToSelf = await textsInHistory(alice3, aliceUser);
  check("X.1 alice never sees her own sends as inbound from herself",
    aliceSentToSelf.length === 0,
    `unexpected self-as-peer entries: ${JSON.stringify(aliceSentToSelf)}`);

  // Total messages alice received from bob across all (reconnect-spanning)
  // sessions: should be exactly the ones bob sent her. Query the store
  // via alice3 — all three alice instances share the same scoped KV
  // store, so it's the merged view, race-free against drainPending.
  const aliceFromBob = await textsInHistory(alice3, bobUser);
  const expectedAliceFromBob = new Set([
    "s1-hi-from-bobA",
    "s3-from-bobA",
    "s4-from-bobB",
    "s5-while-alice-offline",
  ]);
  const aliceMissing = [...expectedAliceFromBob].filter((t) => !aliceFromBob.includes(t));
  check("X.2 alice received every message bob sent her (no losses)",
    aliceMissing.length === 0,
    `missing: ${JSON.stringify(aliceMissing)}, all received: ${JSON.stringify(aliceFromBob)}`);

  await Promise.all([
    alice3.sdk.disconnect(),
    bobA2.sdk.disconnect(),
    bobB2.sdk.disconnect(),
    bobC.sdk.disconnect(),
  ]);
});
