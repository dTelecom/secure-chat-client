// Debug: alice reconnect → existing-session send via live WS to bob-A/bob-B
//
// Investigates the scenario-7 finding: in a multi-reconnect path that
// also adds a new bob-C device, alice's send via existing sessions
// (bob-A, bob-B) doesn't surface in their SDK history even though they
// have live WS connections. Goal: isolate which step breaks it.
//
// Variants run sequentially against the same mock + tunnel:
//   V1. plain reconnect: alice ↔ bob-A, bob-B. alice disconnects.
//       reconnect as alice2. alice2 sends → bob-A and bob-B receive?
//   V2. reconnect + new device: alice ↔ bob-A, bob-B. alice disconnect.
//       new bob-C registered. alice reconnect as alice2. alice2 sends
//       → bob-A, bob-B, bob-C receive?
//   V3. double reconnect: alice → alice2 → alice3. alice3 sends → bob-A
//       and bob-B receive?
//   V4. double reconnect + new device: alice → alice2 → bob-C added →
//       alice3 sends → bob-A, bob-B, bob-C receive? (matches scenario 7)

import { runSmoke, sdkConnect, resetMock, delay, waitFor, type SdkSide } from "./_smoke-helpers.js";

interface Log {
  received: { peer: string; text: string }[];
}

function track(side: SdkSide): Log {
  const log: Log = { received: [] };
  side.sdk.on("message", (e) => {
    log.received.push({ peer: e.peerUserId, text: e.message.text ?? "" });
  });
  return log;
}

async function textsInHistory(side: SdkSide, peer: string): Promise<string[]> {
  const msgs = await side.sdk.getHistory(peer, { limit: 100 });
  return msgs.map((m) => m.text ?? "");
}

async function variant(
  name: string,
  setup: () => Promise<{
    aliceUser: string;
    bobUser: string;
    aliceFinal: SdkSide;
    bobsFinal: SdkSide[]; // live SDKs that should receive
  }>,
): Promise<{ name: string; results: { peer: string; received: boolean }[] }> {
  console.log(`\n--- ${name} ---`);
  await resetMock();
  const { aliceUser, bobUser, aliceFinal, bobsFinal } = await setup();
  await delay(1000); // settle WS for all parties

  // Pre-send diag — what's in each bob's history at reconnect time?
  for (const side of bobsFinal) {
    const hist = await textsInHistory(side, aliceUser);
    console.log(`  [pre-send] ${side.deviceId} history from ${aliceUser}: ${JSON.stringify(hist)}`);
  }

  // Listen for messageSendFailed on the sender to catch any partial-fanout failures.
  aliceFinal.sdk.on("messageSendFailed", (e) => {
    console.log(`  [send-failed] ${JSON.stringify(e)}`);
  });

  // Check mock state right before + after the send to see whether
  // envelopes queued (node thought target offline) or not (node
  // delivered via WS).
  const beforeMock = await (await import("./_smoke-helpers.js")).getMockState();
  console.log(`  [mock-before] ${JSON.stringify(beforeMock.envelopes_by_recipient)}`);

  const tag = `${name}-msg-${Date.now()}`;
  await aliceFinal.sdk.sendText(bobUser, tag);
  await delay(500);
  const afterMock = await (await import("./_smoke-helpers.js")).getMockState();
  console.log(`  [mock-after]  ${JSON.stringify(afterMock.envelopes_by_recipient)}`);

  const results: { peer: string; received: boolean }[] = [];
  for (const side of bobsFinal) {
    let received = false;
    try {
      await waitFor(
        async () => ((await textsInHistory(side, aliceUser)).includes(tag) ? true : undefined),
        8_000, `${side.deviceId} to receive`,
      );
      received = true;
    } catch {}
    results.push({ peer: side.deviceId, received });
    console.log(`  ${received ? "✓" : "✗"} ${side.deviceId} received ${received ? "tag" : "NOTHING"}`);
  }

  // Cleanup
  await aliceFinal.sdk.disconnect();
  for (const side of bobsFinal) await side.sdk.disconnect();

  return { name, results };
}

await runSmoke("debug:reconnect-existing-session", async () => {
  const summary: { name: string; results: { peer: string; received: boolean }[] }[] = [];

  // ── V1: plain reconnect, NO new device ─────────────────────────────────
  summary.push(await variant("V1 plain reconnect (no new device)", async () => {
    const t = Date.now();
    const aliceUser = `a-v1-${t}`;
    const bobUser = `b-v1-${t}`;

    const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
    const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB = await sdkConnect(bobUser, { deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });
    track(bobA); track(bobB);

    // Warm sessions: alice → bob (establishes alice↔bob-A, alice↔bob-B)
    await alice.sdk.sendText(bobUser, "warmup");
    await waitFor(
      async () => ((await textsInHistory(bobA, aliceUser)).includes("warmup")
        && (await textsInHistory(bobB, aliceUser)).includes("warmup") ? true : undefined),
      8_000, "warmup to land",
    );

    // alice disconnect, reconnect (same store)
    await alice.sdk.disconnect();
    await delay(500);
    const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });

    return { aliceUser, bobUser, aliceFinal: alice2, bobsFinal: [bobA, bobB] };
  }));

  // ── V2: reconnect + new device added ───────────────────────────────────
  summary.push(await variant("V2 reconnect + new device (bob-C added)", async () => {
    const t = Date.now();
    const aliceUser = `a-v2-${t}`;
    const bobUser = `b-v2-${t}`;

    const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
    const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB = await sdkConnect(bobUser, { deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });
    track(bobA); track(bobB);

    await alice.sdk.sendText(bobUser, "warmup");
    await waitFor(
      async () => ((await textsInHistory(bobA, aliceUser)).includes("warmup")
        && (await textsInHistory(bobB, aliceUser)).includes("warmup") ? true : undefined),
      8_000, "warmup to land",
    );

    await alice.sdk.disconnect();
    await delay(500);

    // New device added while alice is offline.
    const bobC = await sdkConnect(bobUser, { deviceId: "bob-C", backgroundDiscoveryFloorMs: 0 });
    track(bobC);

    const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });

    return { aliceUser, bobUser, aliceFinal: alice2, bobsFinal: [bobA, bobB, bobC] };
  }));

  // ── V3: double reconnect ───────────────────────────────────────────────
  summary.push(await variant("V3 double reconnect (no new device)", async () => {
    const t = Date.now();
    const aliceUser = `a-v3-${t}`;
    const bobUser = `b-v3-${t}`;

    const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
    const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB = await sdkConnect(bobUser, { deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });
    track(bobA); track(bobB);

    await alice.sdk.sendText(bobUser, "warmup");
    await waitFor(
      async () => ((await textsInHistory(bobA, aliceUser)).includes("warmup")
        && (await textsInHistory(bobB, aliceUser)).includes("warmup") ? true : undefined),
      8_000, "warmup",
    );

    await alice.sdk.disconnect();
    await delay(500);
    const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });
    await alice2.sdk.disconnect();
    await delay(500);
    const alice3 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });

    return { aliceUser, bobUser, aliceFinal: alice3, bobsFinal: [bobA, bobB] };
  }));

  // ── V4: double reconnect + new device (matches scenario 7) ─────────────
  summary.push(await variant("V4 double reconnect + new device (matches scenario 7)", async () => {
    const t = Date.now();
    const aliceUser = `a-v4-${t}`;
    const bobUser = `b-v4-${t}`;

    const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
    const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB = await sdkConnect(bobUser, { deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });
    track(bobA); track(bobB);

    await alice.sdk.sendText(bobUser, "warmup");
    await waitFor(
      async () => ((await textsInHistory(bobA, aliceUser)).includes("warmup")
        && (await textsInHistory(bobB, aliceUser)).includes("warmup") ? true : undefined),
      8_000, "warmup",
    );

    await alice.sdk.disconnect();
    await delay(500);
    const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });
    await alice2.sdk.disconnect();
    await delay(500);

    const bobC = await sdkConnect(bobUser, { deviceId: "bob-C", backgroundDiscoveryFloorMs: 0 });
    track(bobC);

    const alice3 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });

    return { aliceUser, bobUser, aliceFinal: alice3, bobsFinal: [bobA, bobB, bobC] };
  }));

  // ── V5: BOTH sides reconnect (alice + bobA + bobB), then alice sends ──
  //        Closer to scenario 7's actual conditions: bob's devices have
  //        been disconnected + reconnected (in scenario 6's offline drain)
  //        before alice sends.
  summary.push(await variant("V5 both sides reconnect", async () => {
    const t = Date.now();
    const aliceUser = `a-v5-${t}`;
    const bobUser = `b-v5-${t}`;

    const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
    const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB = await sdkConnect(bobUser, { deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });

    await alice.sdk.sendText(bobUser, "warmup");
    await waitFor(
      async () => ((await textsInHistory(bobA, aliceUser)).includes("warmup")
        && (await textsInHistory(bobB, aliceUser)).includes("warmup") ? true : undefined),
      8_000, "warmup",
    );

    // Disconnect all, reconnect alice + both bobs (mimics scenario 6 end).
    await alice.sdk.disconnect();
    await bobA.sdk.disconnect();
    await bobB.sdk.disconnect();
    await delay(1500);

    const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });
    const bobA2 = await sdkConnect(bobUser, { store: bobA.store, deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB2 = await sdkConnect(bobUser, { store: bobB.store, deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });
    track(bobA2); track(bobB2);

    return { aliceUser, bobUser, aliceFinal: alice2, bobsFinal: [bobA2, bobB2] };
  }));

  // ── V6: V5 + new device (closest to scenario 7) ────────────────────────
  summary.push(await variant("V6 both sides reconnect + new bob-C", async () => {
    const t = Date.now();
    const aliceUser = `a-v6-${t}`;
    const bobUser = `b-v6-${t}`;

    const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
    const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB = await sdkConnect(bobUser, { deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });

    await alice.sdk.sendText(bobUser, "warmup");
    await waitFor(
      async () => ((await textsInHistory(bobA, aliceUser)).includes("warmup")
        && (await textsInHistory(bobB, aliceUser)).includes("warmup") ? true : undefined),
      8_000, "warmup",
    );

    await alice.sdk.disconnect();
    await bobA.sdk.disconnect();
    await bobB.sdk.disconnect();
    await delay(1500);

    const bobA2 = await sdkConnect(bobUser, { store: bobA.store, deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB2 = await sdkConnect(bobUser, { store: bobB.store, deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });
    const bobC = await sdkConnect(bobUser, { deviceId: "bob-C", backgroundDiscoveryFloorMs: 0 });
    track(bobA2); track(bobB2); track(bobC);

    const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });

    return { aliceUser, bobUser, aliceFinal: alice2, bobsFinal: [bobA2, bobB2, bobC] };
  }));

  // ── V7: V6 + bidirectional warmup (bob-A sends, bob-B sends) ──────────
  //        Replicates scenario 7's path: lots of bidirectional traffic
  //        through the alice↔bob-A and alice↔bob-B sessions before the
  //        reconnect-then-send.
  summary.push(await variant("V7 bidirectional warmup + both reconnect + new bob-C", async () => {
    const t = Date.now();
    const aliceUser = `a-v7-${t}`;
    const bobUser = `b-v7-${t}`;

    const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
    const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB = await sdkConnect(bobUser, { deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });

    // Bidirectional warmup mimicking scenarios 1-4 traffic.
    await alice.sdk.sendText(bobUser, "w1-alice-to-bob");
    await waitFor(
      async () => ((await textsInHistory(bobA, aliceUser)).includes("w1-alice-to-bob") ? true : undefined),
      5_000, "bobA w1",
    );
    await bobA.sdk.sendText(aliceUser, "w2-bobA-to-alice");
    await waitFor(
      async () => ((await textsInHistory(alice, bobUser)).includes("w2-bobA-to-alice") ? true : undefined),
      5_000, "alice w2",
    );
    await bobB.sdk.sendText(aliceUser, "w3-bobB-to-alice");
    await waitFor(
      async () => ((await textsInHistory(alice, bobUser)).includes("w3-bobB-to-alice") ? true : undefined),
      5_000, "alice w3",
    );
    await delay(2000); // settle batched received-acks

    await alice.sdk.disconnect();
    await bobA.sdk.disconnect();
    await bobB.sdk.disconnect();
    await delay(1500);

    const bobA2 = await sdkConnect(bobUser, { store: bobA.store, deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB2 = await sdkConnect(bobUser, { store: bobB.store, deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });
    const bobC = await sdkConnect(bobUser, { deviceId: "bob-C", backgroundDiscoveryFloorMs: 0 });
    track(bobA2); track(bobB2); track(bobC);

    const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });

    return { aliceUser, bobUser, aliceFinal: alice2, bobsFinal: [bobA2, bobB2, bobC] };
  }));

  // ── V7b: V7 + monitor bobA2/bobB2 WS state across the bobC-add window
  //         to see if their WS gets dropped when bobC connects ─────────
  summary.push(await variant("V7b V7 with WS-state monitoring", async () => {
    const t = Date.now();
    const aliceUser = `a-v7b-${t}`;
    const bobUser = `b-v7b-${t}`;

    const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
    const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB = await sdkConnect(bobUser, { deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });

    await alice.sdk.sendText(bobUser, "w1");
    await waitFor(async () => ((await textsInHistory(bobA, aliceUser)).includes("w1") ? true : undefined), 5_000, "bobA w1");
    await bobA.sdk.sendText(aliceUser, "w2");
    await waitFor(async () => ((await textsInHistory(alice, bobUser)).includes("w2") ? true : undefined), 5_000, "alice w2");
    await bobB.sdk.sendText(aliceUser, "w3");
    await waitFor(async () => ((await textsInHistory(alice, bobUser)).includes("w3") ? true : undefined), 5_000, "alice w3");
    await delay(2000);

    await alice.sdk.disconnect();
    await bobA.sdk.disconnect();
    await bobB.sdk.disconnect();
    await delay(1500);

    const bobA2 = await sdkConnect(bobUser, { store: bobA.store, deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB2 = await sdkConnect(bobUser, { store: bobB.store, deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });
    track(bobA2); track(bobB2);

    // Subscribe to WS state changes for bobA2 + bobB2
    bobA2.sdk.on("connectionStateChange", (e) => {
      console.log(`  [ws] bob-A2 state → ${e.state}`);
    });
    bobB2.sdk.on("connectionStateChange", (e) => {
      console.log(`  [ws] bob-B2 state → ${e.state}`);
    });

    // Now connect bobC and watch what happens to bobA2/bobB2's WS
    console.log(`  [marker] about to connect bobC`);
    const bobC = await sdkConnect(bobUser, { deviceId: "bob-C", backgroundDiscoveryFloorMs: 0 });
    track(bobC);
    console.log(`  [marker] bobC connected; waiting 2s before alice2`);
    await delay(2000);
    console.log(`  [marker] about to connect alice2`);
    const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });
    console.log(`  [marker] alice2 connected; setup done`);

    return { aliceUser, bobUser, aliceFinal: alice2, bobsFinal: [bobA2, bobB2, bobC] };
  }));

  // ── V10: ONLY bobA bidirectional (bobB silent), then reconnect+bobC ─
  summary.push(await variant("V10 bobA bidir, bobB silent, +bobC", async () => {
    const t = Date.now();
    const aliceUser = `a-v10-${t}`;
    const bobUser = `b-v10-${t}`;

    const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
    const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB = await sdkConnect(bobUser, { deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });

    await alice.sdk.sendText(bobUser, "w1");
    await waitFor(async () => ((await textsInHistory(bobA, aliceUser)).includes("w1")
      && (await textsInHistory(bobB, aliceUser)).includes("w1") ? true : undefined), 5_000, "w1");
    await bobA.sdk.sendText(aliceUser, "w2");
    await waitFor(async () => ((await textsInHistory(alice, bobUser)).includes("w2") ? true : undefined), 5_000, "w2");
    // bobB does NOT send
    await delay(2000);

    await alice.sdk.disconnect();
    await bobA.sdk.disconnect();
    await bobB.sdk.disconnect();
    await delay(1500);

    const bobA2 = await sdkConnect(bobUser, { store: bobA.store, deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB2 = await sdkConnect(bobUser, { store: bobB.store, deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });
    const bobC = await sdkConnect(bobUser, { deviceId: "bob-C", backgroundDiscoveryFloorMs: 0 });
    track(bobA2); track(bobB2); track(bobC);

    const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });

    return { aliceUser, bobUser, aliceFinal: alice2, bobsFinal: [bobA2, bobB2, bobC] };
  }));

  // ── V8: minimal bidirectional — one ping-pong, then reconnect ─────────
  //        No bob-B, no bob-C, no new device. Just alice ↔ bobA with one
  //        back-and-forth, then both reconnect, then alice sends. If
  //        this fails, the bug is in bidirectional session restore.
  summary.push(await variant("V8 minimal bidirectional (alice↔bobA only)", async () => {
    const t = Date.now();
    const aliceUser = `a-v8-${t}`;
    const bobUser = `b-v8-${t}`;

    const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
    const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });

    await alice.sdk.sendText(bobUser, "w1");
    await waitFor(
      async () => ((await textsInHistory(bobA, aliceUser)).includes("w1") ? true : undefined),
      5_000, "bobA w1",
    );
    await bobA.sdk.sendText(aliceUser, "w2");
    await waitFor(
      async () => ((await textsInHistory(alice, bobUser)).includes("w2") ? true : undefined),
      5_000, "alice w2",
    );
    await delay(1500); // batched received-acks settle

    await alice.sdk.disconnect();
    await bobA.sdk.disconnect();
    await delay(1500);

    const bobA2 = await sdkConnect(bobUser, { store: bobA.store, deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    track(bobA2);
    const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });

    return { aliceUser, bobUser, aliceFinal: alice2, bobsFinal: [bobA2] };
  }));

  // ── V9: bidirectional + bob-B sends + reconnect (no bob-C) ────────────
  //        Like V7 but without the new device. Tests whether the new
  //        device is needed to trigger the bug.
  summary.push(await variant("V9 bidir + bob-B sends + reconnect (no bob-C)", async () => {
    const t = Date.now();
    const aliceUser = `a-v9-${t}`;
    const bobUser = `b-v9-${t}`;

    const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
    const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB = await sdkConnect(bobUser, { deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });

    await alice.sdk.sendText(bobUser, "w1");
    await waitFor(
      async () => ((await textsInHistory(bobA, aliceUser)).includes("w1") ? true : undefined),
      5_000, "bobA w1",
    );
    await bobA.sdk.sendText(aliceUser, "w2");
    await waitFor(
      async () => ((await textsInHistory(alice, bobUser)).includes("w2") ? true : undefined),
      5_000, "alice w2",
    );
    await bobB.sdk.sendText(aliceUser, "w3");
    await waitFor(
      async () => ((await textsInHistory(alice, bobUser)).includes("w3") ? true : undefined),
      5_000, "alice w3",
    );
    await delay(2000);

    await alice.sdk.disconnect();
    await bobA.sdk.disconnect();
    await bobB.sdk.disconnect();
    await delay(1500);

    const bobA2 = await sdkConnect(bobUser, { store: bobA.store, deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobB2 = await sdkConnect(bobUser, { store: bobB.store, deviceId: "bob-B", backgroundDiscoveryFloorMs: 0 });
    track(bobA2); track(bobB2);
    const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });

    return { aliceUser, bobUser, aliceFinal: alice2, bobsFinal: [bobA2, bobB2] };
  }));

  // ── V11: V8 + bobC added before alice send ────────────────────────────
  //         alice + bobA bidirectional, no bobB. Reconnect + add bobC.
  summary.push(await variant("V11 V8 + bobC added", async () => {
    const t = Date.now();
    const aliceUser = `a-v11-${t}`;
    const bobUser = `b-v11-${t}`;

    const alice = await sdkConnect(aliceUser, { deviceId: "alice-mac", backgroundDiscoveryFloorMs: 0 });
    const bobA = await sdkConnect(bobUser, { deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });

    await alice.sdk.sendText(bobUser, "w1");
    await waitFor(async () => ((await textsInHistory(bobA, aliceUser)).includes("w1") ? true : undefined), 5_000, "w1");
    await bobA.sdk.sendText(aliceUser, "w2");
    await waitFor(async () => ((await textsInHistory(alice, bobUser)).includes("w2") ? true : undefined), 5_000, "w2");
    await delay(2000);

    await alice.sdk.disconnect();
    await bobA.sdk.disconnect();
    await delay(1500);

    const bobA2 = await sdkConnect(bobUser, { store: bobA.store, deviceId: "bob-A", backgroundDiscoveryFloorMs: 0 });
    const bobC = await sdkConnect(bobUser, { deviceId: "bob-C", backgroundDiscoveryFloorMs: 0 });
    track(bobA2); track(bobC);

    const alice2 = await sdkConnect(aliceUser, { store: alice.store, backgroundDiscoveryFloorMs: 0 });

    return { aliceUser, bobUser, aliceFinal: alice2, bobsFinal: [bobA2, bobC] };
  }));

  console.log("\n=== summary ===");
  for (const v of summary) {
    const failures = v.results.filter((r) => !r.received);
    const status = failures.length === 0 ? "PASS" : `FAIL: ${failures.map((f) => f.peer).join(",")} missed`;
    console.log(`  ${v.name}: ${status}`);
  }
});
