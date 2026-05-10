// smoke:read-receipts-gating — verifies that bob's local
// `setReadReceiptsEnabled(false)` actually suppresses the outbound
// `chat.read` event so alice's StatusTracker never observes the message
// as `read`. The toggle is persisted in bob's local KV; the gating is
// inside `markRead`, which is the only path that emits the read event.
//
//   step 1: bob disables read receipts.
//   step 2: alice sends a message; bob receives + calls markRead.
//   step 3: assert alice's status for the message ratchets through
//           sent → delivered (and stays there) — never reaching `read`.
//   step 4: bob re-enables, alice sends again, bob marks read; alice's
//           status DOES reach `read` (proves the wire is working when
//           the gate is open).

import { runSmoke, check, sdkConnect, resetMock, delay, waitFor } from "./_smoke-helpers.js";
import type { StatusChangeEvt } from "../src/index.js";

await runSmoke("smoke:read-receipts-gating", async () => {
  await resetMock();

  const aliceUser = `alice-rrg-${Date.now()}`;
  const bobUser = `bob-rrg-${Date.now()}`;

  const alice = await sdkConnect(aliceUser);
  const bob = await sdkConnect(bobUser);

  // ── step 1: bob disables.
  await bob.sdk.setReadReceiptsEnabled(false);

  // Track alice's status for each message id.
  const statusByMessage = new Map<string, string[]>();
  alice.sdk.on("statusChange", (e: StatusChangeEvt) => {
    const arr = statusByMessage.get(e.messageId) ?? [];
    arr.push(e.status);
    statusByMessage.set(e.messageId, arr);
  });

  // ── step 2: alice sends; bob receives; bob calls markRead.
  const id1 = await alice.sdk.sendText(bobUser, "gated-read");
  let bobMessageId = "";
  bob.sdk.on("message", (e) => {
    if (e.peerUserId === aliceUser && e.message.text === "gated-read") {
      bobMessageId = e.message.id;
    }
  });
  await waitFor(() => (bobMessageId ? bobMessageId : undefined),
    8_000, "bob to receive gated-read");
  await bob.sdk.markRead(aliceUser, bobMessageId);

  // Allow the (suppressed) read event time to NOT travel.
  await delay(3_000);

  const seenForId1 = statusByMessage.get(id1) ?? [];
  check("disabled: alice never saw 'read' for message 1",
    !seenForId1.includes("read"),
    `statuses: ${JSON.stringify(seenForId1)}`);
  // Sanity — at least 'sent' should have appeared so we know the listener is live.
  check("disabled: alice DID see at least 'sent' (listener is wired)",
    seenForId1.includes("sent"),
    `statuses: ${JSON.stringify(seenForId1)}`);

  // ── step 3: re-enable; new message gets through to read.
  await bob.sdk.setReadReceiptsEnabled(true);

  const id2 = await alice.sdk.sendText(bobUser, "ungated-read");
  let bobMessageId2 = "";
  const off = bob.sdk.on("message", (e) => {
    if (e.peerUserId === aliceUser && e.message.text === "ungated-read") {
      bobMessageId2 = e.message.id;
    }
  });
  await waitFor(() => (bobMessageId2 ? bobMessageId2 : undefined),
    8_000, "bob to receive ungated-read");
  off();
  await bob.sdk.markRead(aliceUser, bobMessageId2);

  await waitFor(
    () => ((statusByMessage.get(id2) ?? []).includes("read") ? true : undefined),
    8_000, "alice to see 'read' for message 2",
  );
  check("re-enabled: alice's status reaches 'read'",
    (statusByMessage.get(id2) ?? []).includes("read"),
    `statuses: ${JSON.stringify(statusByMessage.get(id2))}`);

  await Promise.all([alice.sdk.disconnect(), bob.sdk.disconnect()]);
});
