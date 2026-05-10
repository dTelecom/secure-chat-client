// smoke:edit-delete-authz — verifies edit/delete authorization is
// cryptographically bound to the original sender's Olm session. A peer
// (mallory) trying to edit/delete a message claiming to be from someone
// else must be silently ignored by the recipient's MessageStore.
//
// Approach: alice sends m1 to bob. Mallory (a third user) sends bob an
// edit event referencing m1's id. Because mallory's Olm session with
// bob has senderUserId=mallory, MessageStore.applyEdit fails the
// authorization check (target.senderUserId === editorUserId).

import { runSmoke, check, sdkConnect, waitFor, delay } from "./_smoke-helpers.js";

await runSmoke("smoke:edit-delete-authz", async () => {
  const alice = await sdkConnect(`alice-authz-${Date.now()}`);
  const bob = await sdkConnect(`bob-authz-${Date.now()}`);
  const mallory = await sdkConnect(`mallory-authz-${Date.now()}`);

  // Bob receives message text events; we'll inspect them.
  const bobMessages: Array<{ id: string; text: string; from: string }> = [];
  bob.sdk.on("message", (e) => {
    bobMessages.push({ id: e.message.id, text: e.message.text, from: e.peerUserId });
  });
  let mallEditFired = false;
  let aliceEditFired = false;
  bob.sdk.on("messageEdited", (e) => {
    // Only legitimate edits (from the original sender) reach here. We
    // distinguish by which message id was targeted — alice's edit fires
    // here, mallory's silently drops at the store layer.
    if (e.peerUserId === alice.userId) aliceEditFired = true;
    else if (e.peerUserId === mallory.userId) mallEditFired = true;
  });

  // Step 1: alice sends m1 to bob.
  const m1 = await alice.sdk.sendText(bob.userId, "the original from alice");
  await waitFor(() => bobMessages.find((m) => m.id === m1), 10_000, "bob to receive alice's message");
  check("bob received alice's message", bobMessages.length === 1 && bobMessages[0].text === "the original from alice");

  // Step 2: mallory sends a forged edit to bob, claiming targetId=m1.
  // We use the sdk's editMessage path — but mallory's session with bob
  // is bound to senderUserId=mallory. Bob's MessageStore.applyEdit will
  // fail the senderUserId check because m1.senderUserId === alice's id.
  await mallory.sdk.editMessage(bob.userId, m1, "FORGED CONTENT FROM MALLORY");
  await delay(2000);

  check("forged edit from mallory did NOT fire messageEdited", !mallEditFired);
  // bob's stored text should still be alice's original.
  const history = await bob.sdk.getHistory(alice.userId);
  const stored = history.find((m) => m.id === m1);
  check("bob's local message still has alice's original text", stored?.text === "the original from alice",
    `got: ${stored?.text ?? "(missing)"}`);

  // Step 3: alice sends a legitimate edit. Should apply.
  await alice.sdk.editMessage(bob.userId, m1, "edited by the real alice");
  await waitFor(() => aliceEditFired || undefined, 10_000, "bob to apply alice's legit edit");
  const history2 = await bob.sdk.getHistory(alice.userId);
  const stored2 = history2.find((m) => m.id === m1);
  check("legitimate edit from alice applied", stored2?.text === "edited by the real alice");

  // Step 4: mallory's forged DELETE must also be ignored.
  await mallory.sdk.deleteMessage(bob.userId, m1);
  await delay(2000);
  const history3 = await bob.sdk.getHistory(alice.userId);
  const stored3 = history3.find((m) => m.id === m1);
  check("forged delete from mallory did NOT tombstone alice's message",
    stored3?.deletedAt === null && stored3?.text === "edited by the real alice");

  await Promise.all([alice.sdk.disconnect(), bob.sdk.disconnect(), mallory.sdk.disconnect()]);
});
