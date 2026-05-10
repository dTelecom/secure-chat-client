// smoke:read-typing — read receipts and typing indicators end-to-end
// through the deployed mesh.

import { runSmoke, check, sdkConnect, waitFor, delay } from "./_smoke-helpers.js";

await runSmoke("smoke:read-typing", async () => {
  const alice = await sdkConnect(`alice-rt-${Date.now()}`);
  const bob = await sdkConnect(`bob-rt-${Date.now()}`);

  // Wire bob's message listener BEFORE sending — otherwise messages that
  // arrive in the SDK before the listener is attached fire into the void.
  const bobReceived: string[] = [];
  bob.sdk.on("message", (e) => bobReceived.push(e.message.id));

  // ── Read flow ───────────────────────────────────────────────────────────
  // alice sends 5 messages; bob marks the last one as read; alice's
  // statusChange ratchets all five to "read".
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(await alice.sdk.sendText(bob.userId, `read-test ${i}`));
    await delay(200); // small spacing so chronological order is stable
  }

  await waitFor(() => (bobReceived.length >= 5 ? true : undefined), 15_000, "bob to receive all 5");
  check("bob received all 5 messages", bobReceived.length >= 5);

  // alice tracks read transitions.
  const readMessages = new Set<string>();
  alice.sdk.on("statusChange", (e) => {
    if (e.status === "read") readMessages.add(e.messageId);
  });
  // Bob marks the latest as read — covers all earlier via watermark.
  await bob.sdk.markRead(alice.userId, ids[ids.length - 1]);
  await waitFor(() => (readMessages.size >= 5 ? true : undefined), 10_000, "alice to see all 5 as read");
  check("alice sees all 5 messages as read (watermark)", ids.every((id) => readMessages.has(id)));

  // ── Typing flow ─────────────────────────────────────────────────────────
  const typingEvents: Array<{ state: string; ts: number }> = [];
  bob.sdk.on("typing", (e) => {
    if (e.peerUserId === alice.userId) typingEvents.push({ state: e.state, ts: Date.now() });
  });

  alice.sdk.setTyping(bob.userId, true);
  await waitFor(
    () => (typingEvents.find((t) => t.state === "started") ? true : undefined),
    5_000,
    "bob to see typing started",
  );
  check("bob saw typing started", typingEvents.some((t) => t.state === "started"));

  // Sending a real message should clear typing.
  await alice.sdk.sendText(bob.userId, "and here's the actual message");
  await waitFor(
    () => (typingEvents.find((t) => t.state === "stopped") ? true : undefined),
    5_000,
    "bob to see typing stopped after send",
  );
  check("typing auto-stopped on send", typingEvents.some((t) => t.state === "stopped"));

  // Auto-stop timer (5s of no activity) — start typing again, wait 6s, expect stopped.
  typingEvents.length = 0;
  alice.sdk.setTyping(bob.userId, true);
  await waitFor(
    () => (typingEvents.find((t) => t.state === "started") ? true : undefined),
    5_000,
    "bob to see typing started (round 2)",
  );
  await delay(6_000);
  check("typing auto-stopped after 5s of inactivity",
    typingEvents.some((t) => t.state === "stopped"));

  await Promise.all([alice.sdk.disconnect(), bob.sdk.disconnect()]);
});
