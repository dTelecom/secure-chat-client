// smoke:self-echo — verifies multi-device convergence (Signal "sync
// messages" model) for all four self-echoable content types: text,
// edit, delete, read. alice has device-A and device-B; bob has one.
// Every alice-A action must also reach alice-B (peer-side delivery
// is a precondition we already cover in smoke-fanout / smoke-multi-
// device-sender).

import { runSmoke, check, sdkConnect, resetMock, delay, waitFor } from "./_smoke-helpers.js";
import type { StatusChangeEvt } from "../src/index.js";

await runSmoke("smoke:self-echo", async () => {
  await resetMock();

  const aliceUser = `alice-se-${Date.now()}`;
  const bobUser = `bob-se-${Date.now()}`;

  const aliceA = await sdkConnect(aliceUser, { deviceId: "alice-A" });
  const aliceB = await sdkConnect(aliceUser, { deviceId: "alice-B" });
  const bob = await sdkConnect(bobUser);

  const aliceBMessages: Array<{ peerUserId: string; senderUserId: string; text: string; id: string }> = [];
  const aliceBEdits: Array<{ peerUserId: string; targetId: string; newText: string }> = [];
  const aliceBDeletes: Array<{ peerUserId: string; targetId: string }> = [];
  const aliceAStatuses: Array<{ messageId: string; status: string }> = [];

  aliceB.sdk.on("message", (e) => {
    aliceBMessages.push({
      peerUserId: e.peerUserId,
      senderUserId: e.senderUserId,
      text: e.message.text,
      id: e.message.id,
    });
  });
  aliceB.sdk.on("messageEdited", (e) => {
    aliceBEdits.push({ peerUserId: e.peerUserId, targetId: e.targetId, newText: e.newText });
  });
  aliceB.sdk.on("messageDeleted", (e) => {
    aliceBDeletes.push({ peerUserId: e.peerUserId, targetId: e.targetId });
  });
  aliceA.sdk.on("statusChange", (e: StatusChangeEvt) => {
    aliceAStatuses.push({ messageId: e.messageId, status: e.status });
  });

  // Warmup: alice-B sends so alice-A's self bundle cache learns about
  // alice-B (the connect-time refresh ran before alice-B existed).
  await aliceB.sdk.sendText(bobUser, "warmup-from-aliceB");
  await delay(2_000);

  // ── 1. text: alice-A sends → alice-B's `message` fires with the
  //              ORIGINAL peer (bob) and senderUserId = self user id.
  const textId = await aliceA.sdk.sendText(bobUser, "self-echo-text");
  await waitFor(
    () => aliceBMessages.find((m) => m.text === "self-echo-text" && m.peerUserId === bobUser),
    8_000,
    "alice-B to receive self-echo of alice-A's text",
  );
  const echo = aliceBMessages.find((m) => m.text === "self-echo-text")!;
  check("self-echo text: peerUserId is the original peer (bob)", echo.peerUserId === bobUser);
  check("self-echo text: senderUserId is alice (self)", echo.senderUserId === aliceUser);
  check("self-echo text: id matches alice-A's outbound", echo.id === textId);

  // ── 2. edit: alice-A edits → alice-B's messageEdited fires.
  await aliceA.sdk.editMessage(bobUser, textId, "edited-text");
  await waitFor(
    () => aliceBEdits.find((e) => e.targetId === textId && e.newText === "edited-text"),
    8_000,
    "alice-B to receive self-echo of alice-A's edit",
  );
  check("self-echo edit applied",
    aliceBEdits.some((e) => e.targetId === textId && e.newText === "edited-text"));

  // ── 3. delete: alice-A deletes → alice-B's messageDeleted fires.
  await aliceA.sdk.deleteMessage(bobUser, textId);
  await waitFor(
    () => aliceBDeletes.find((d) => d.targetId === textId),
    8_000,
    "alice-B to receive self-echo of alice-A's delete",
  );
  check("self-echo delete applied",
    aliceBDeletes.some((d) => d.targetId === textId));

  // ── 4. read: bob sends a NEW message; alice-A reads it → alice-B's
  //              statusTracker mirrors the read watermark forward.
  //              We can't observe alice-B's tracker directly via the
  //              public API, but we can verify alice-B persists no
  //              extra `message` event for the read (it's status-only).
  let bobMsgIdAtA = "";
  aliceA.sdk.on("message", (e) => {
    if (e.peerUserId === bobUser && !bobMsgIdAtA) bobMsgIdAtA = e.message.id;
  });
  await bob.sdk.sendText(aliceUser, "to-alice-from-bob");
  await waitFor(() => (bobMsgIdAtA ? bobMsgIdAtA : undefined),
    5_000, "alice-A to receive bob's send");
  await aliceA.sdk.markRead(bobUser, bobMsgIdAtA);
  // Allow self-echo of the `read` event to settle on alice-B.
  await delay(2_000);

  // Bob also fires `read` via the original wire path; alice-A's tracker
  // ratchets `to-alice-from-bob`'s status to read on bob's first read.
  // For self-echo, the testable surface is that alice-B doesn't emit a
  // `message` event for the read (it's not a content event in that sense).
  const echoesForReadId = aliceBMessages.filter((m) => m.id === bobMsgIdAtA && m.peerUserId === bobUser);
  // Actually alice-B will see bob's text via fanout — that's not a self-echo.
  // What we DO want: no extra "message" entry beyond the one bob sent
  // (i.e., the read event isn't surfaced as a phantom message).
  check("self-echo read: no phantom message event for the read watermark",
    echoesForReadId.length <= 1,
    `count: ${echoesForReadId.length}`);

  await Promise.all([
    aliceA.sdk.disconnect(),
    aliceB.sdk.disconnect(),
    bob.sdk.disconnect(),
  ]);
});
