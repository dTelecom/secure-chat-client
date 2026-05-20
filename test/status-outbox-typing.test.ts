// Tests for the sender-side status state machine, the outbox, the typing
// manager, and the message store's edit/delete authorization.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageStore } from "../src/message_store.js";
import { Outbox } from "../src/outbox.js";
import { StatusTracker, type MessageStatus } from "../src/status.js";
import { MemoryKVStore } from "../src/store/memory-adapter.js";
import { TypingManager } from "../src/typing.js";

// ── StatusTracker ────────────────────────────────────────────────────────────

describe("StatusTracker", () => {
  function setup() {
    const tracker = new StatusTracker();
    const transitions: Array<{ id: string; status: MessageStatus; peer: string }> = [];
    tracker.on((id, status, peer) => transitions.push({ id, status, peer }));
    return { tracker, transitions };
  }

  it("send result → sent", () => {
    const { tracker, transitions } = setup();
    tracker.trackOutbound({
      messageId: "m1",
      peerUserId: "bob",
      envelopeToDevice: new Map([["e1", "bob-phone"]]),
    });
    tracker.onSendResult("e1", "live");
    expect(tracker.getStatus("m1")).toBe("sent");
    expect(transitions).toEqual([{ id: "m1", status: "sent", peer: "bob" }]);
  });

  it("received from one of two peer devices → delivered, not deliveredAll", () => {
    const { tracker } = setup();
    tracker.trackOutbound({
      messageId: "m1",
      peerUserId: "bob",
      envelopeToDevice: new Map([
        ["e-phone", "bob-phone"],
        ["e-laptop", "bob-laptop"],
      ]),
    });
    tracker.onSendResult("e-phone", "live");
    tracker.onSendResult("e-laptop", "stored");
    tracker.onReceived({ peerUserId: "bob", peerDeviceId: "bob-phone", messageIds: ["m1"] });
    expect(tracker.getStatus("m1")).toBe("delivered");
  });

  it("received from all peer devices → deliveredAll", () => {
    const { tracker } = setup();
    tracker.trackOutbound({
      messageId: "m1",
      peerUserId: "bob",
      envelopeToDevice: new Map([
        ["e-phone", "bob-phone"],
        ["e-laptop", "bob-laptop"],
      ]),
    });
    tracker.onReceived({ peerUserId: "bob", peerDeviceId: "bob-phone", messageIds: ["m1"] });
    tracker.onReceived({ peerUserId: "bob", peerDeviceId: "bob-laptop", messageIds: ["m1"] });
    expect(tracker.getStatus("m1")).toBe("deliveredAll");
  });

  it("read watermark moves all earlier messages to read", () => {
    const { tracker } = setup();
    for (const id of ["m1", "m2", "m3"]) {
      tracker.trackOutbound({
        messageId: id,
        peerUserId: "bob",
        envelopeToDevice: new Map([[`e-${id}`, "bob-phone"]]),
      });
    }
    tracker.onRead({ peerUserId: "bob", upToId: "m2" });
    expect(tracker.getStatus("m1")).toBe("read");
    expect(tracker.getStatus("m2")).toBe("read");
    expect(tracker.getStatus("m3")).toBe("pending"); // not yet covered
  });

  it("status only ratchets forward, never backwards", () => {
    const { tracker } = setup();
    tracker.trackOutbound({
      messageId: "m1",
      peerUserId: "bob",
      envelopeToDevice: new Map([["e1", "bob-phone"]]),
    });
    tracker.onRead({ peerUserId: "bob", upToId: "m1" });
    expect(tracker.getStatus("m1")).toBe("read");
    // A late chatSendResult shouldn't drop us back to "sent".
    tracker.onSendResult("e1", "live");
    expect(tracker.getStatus("m1")).toBe("read");
  });

  it("ignores results for unknown envelopes", () => {
    const { tracker, transitions } = setup();
    tracker.onSendResult("unknown-uuid", "live");
    tracker.onReceived({ peerUserId: "bob", peerDeviceId: "x", messageIds: ["m-nope"] });
    expect(transitions).toEqual([]);
  });

  // ── 0.13.3 — error → failed downgrade (when every target errors) ──────

  it("single target onSendResult('error') downgrades pending → failed", () => {
    const { tracker, transitions } = setup();
    tracker.trackOutbound({
      messageId: "m1",
      peerUserId: "bob",
      envelopeToDevice: new Map([["e1", "bob-only-device"]]),
    });
    tracker.onSendResult("e1", "error");
    expect(tracker.getStatus("m1")).toBe("failed");
    expect(transitions).toEqual([{ id: "m1", status: "failed", peer: "bob" }]);
  });

  it("single target onSendResult('error') downgrades sent → failed (Option A optimistic-promote case)", () => {
    const { tracker, transitions } = setup();
    tracker.trackOutbound({
      messageId: "m1",
      peerUserId: "bob",
      envelopeToDevice: new Map([["e1", "bob-only-device"]]),
    });
    // Simulate the new 0.13.3 outbox path: locally promote to "sent"
    // before any chatSendResult arrives.
    tracker.onSendResult("e1", "stored");
    expect(tracker.getStatus("m1")).toBe("sent");
    // Now the real chatSendResult comes back with error.
    tracker.onSendResult("e1", "error");
    expect(tracker.getStatus("m1")).toBe("failed");
    expect(transitions.map((t) => t.status)).toEqual(["sent", "failed"]);
  });

  it("multi-target: partial errors with one success stays at 'sent'", () => {
    const { tracker } = setup();
    tracker.trackOutbound({
      messageId: "m1",
      peerUserId: "bob",
      envelopeToDevice: new Map([
        ["e-phone", "bob-phone"],
        ["e-laptop", "bob-laptop"],
      ]),
    });
    tracker.onSendResult("e-phone", "live");
    expect(tracker.getStatus("m1")).toBe("sent");
    tracker.onSendResult("e-laptop", "error");
    // One target errored, the other succeeded — message did reach a
    // device of bob. Don't downgrade.
    expect(tracker.getStatus("m1")).toBe("sent");
  });

  it("multi-target: ALL targets erroring downgrades to failed", () => {
    const { tracker, transitions } = setup();
    tracker.trackOutbound({
      messageId: "m1",
      peerUserId: "bob",
      envelopeToDevice: new Map([
        ["e-phone", "bob-phone"],
        ["e-laptop", "bob-laptop"],
      ]),
    });
    // 0.13.3 optimistic promotion (both targets pre-promoted "stored"
    // locally before any wire response).
    tracker.onSendResult("e-phone", "stored");
    tracker.onSendResult("e-laptop", "stored");
    expect(tracker.getStatus("m1")).toBe("sent");
    // Server returns errors for both.
    tracker.onSendResult("e-phone", "error");
    expect(tracker.getStatus("m1")).toBe("sent"); // only 1/2 errored
    tracker.onSendResult("e-laptop", "error");
    expect(tracker.getStatus("m1")).toBe("failed"); // 2/2 errored
    const lastTransitions = transitions.map((t) => t.status);
    expect(lastTransitions[lastTransitions.length - 1]).toBe("failed");
  });

  it("post-delivery error frames don't downgrade — receiver already saw the message", () => {
    const { tracker } = setup();
    tracker.trackOutbound({
      messageId: "m1",
      peerUserId: "bob",
      envelopeToDevice: new Map([
        ["e-phone", "bob-phone"],
        ["e-laptop", "bob-laptop"],
      ]),
    });
    // bob-phone delivered, then bob-laptop errors. Status stays.
    tracker.onSendResult("e-phone", "live");
    tracker.onReceived({ peerUserId: "bob", peerDeviceId: "bob-phone", messageIds: ["m1"] });
    expect(tracker.getStatus("m1")).toBe("delivered");
    // Late error for the other target.
    tracker.onSendResult("e-laptop", "error");
    expect(tracker.getStatus("m1")).toBe("delivered"); // NOT downgraded
  });

  it("'dropped' status is still a no-op (ephemeral)", () => {
    const { tracker, transitions } = setup();
    tracker.trackOutbound({
      messageId: "m1",
      peerUserId: "bob",
      envelopeToDevice: new Map([["e1", "bob-phone"]]),
    });
    tracker.onSendResult("e1", "dropped");
    expect(tracker.getStatus("m1")).toBe("pending");
    expect(transitions).toEqual([]);
  });
});

// ── MessageStore ────────────────────────────────────────────────────────────

describe("MessageStore edit/delete authorization", () => {
  let store: MessageStore;
  beforeEach(() => {
    store = new MessageStore(new MemoryKVStore());
  });

  async function seed(senderUserId: string) {
    await store.put({
      id: "m1",
      peerUserId: "alice",
      senderUserId,
      text: "original",
      sentAt: 1,
      editedAt: null,
      deletedAt: null,
    });
  }

  it("edit applied when editor is original sender", async () => {
    await seed("bob");
    const updated = await store.applyEdit({
      targetId: "m1",
      editorUserId: "bob",
      newText: "new",
      editedAt: 2,
    });
    expect(updated?.text).toBe("new");
    expect(updated?.editedAt).toBe(2);
  });

  it("edit dropped when editor is NOT original sender (auth fail)", async () => {
    await seed("bob");
    const result = await store.applyEdit({
      targetId: "m1",
      editorUserId: "mallory",
      newText: "tampered",
      editedAt: 2,
    });
    expect(result).toBeNull();
    const target = await store.get("m1");
    expect(target?.text).toBe("original");
  });

  it("delete tombstones (purges text) when authorized", async () => {
    await seed("bob");
    const result = await store.applyDelete({
      targetId: "m1",
      deleterUserId: "bob",
      deletedAt: 5,
    });
    expect(result?.text).toBe("");
    expect(result?.deletedAt).toBe(5);
  });

  it("edit on already-deleted message is dropped", async () => {
    await seed("bob");
    await store.applyDelete({ targetId: "m1", deleterUserId: "bob", deletedAt: 5 });
    const result = await store.applyEdit({
      targetId: "m1",
      editorUserId: "bob",
      newText: "resurrect",
      editedAt: 6,
    });
    expect(result).toBeNull();
  });

  it("survives across MessageStore re-instantiation (KV-backed)", async () => {
    const kv = new MemoryKVStore();
    const a = new MessageStore(kv);
    await a.put({
      id: "m1",
      peerUserId: "alice",
      senderUserId: "self",
      text: "persisted",
      sentAt: 1,
      editedAt: null,
      deletedAt: null,
    });
    const b = new MessageStore(kv);
    const got = await b.get("m1");
    expect(got?.text).toBe("persisted");
  });
});

// ── MessageStore.listForPeer ────────────────────────────────────────────────

describe("MessageStore.listForPeer", () => {
  let store: MessageStore;
  let kv: MemoryKVStore;

  beforeEach(async () => {
    kv = new MemoryKVStore();
    store = new MessageStore(kv);
    // seed: alice has 5 messages, bob has 2
    for (let i = 1; i <= 5; i++) {
      await store.put({
        id: `a${i}`,
        peerUserId: "alice",
        senderUserId: i % 2 === 0 ? "self" : "alice",
        text: `alice-${i}`,
        sentAt: i * 1000,
        editedAt: null,
        deletedAt: null,
      });
    }
    for (let i = 1; i <= 2; i++) {
      await store.put({
        id: `b${i}`,
        peerUserId: "bob",
        senderUserId: "bob",
        text: `bob-${i}`,
        sentAt: 100 + i,
        editedAt: null,
        deletedAt: null,
      });
    }
  });

  it("returns only messages for the requested peer, oldest→newest", async () => {
    const list = await store.listForPeer("alice");
    expect(list).toHaveLength(5);
    expect(list.map((m) => m.id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("does not bleed across peers", async () => {
    const aliceList = await store.listForPeer("alice");
    expect(aliceList.every((m) => m.peerUserId === "alice")).toBe(true);
    const bobList = await store.listForPeer("bob");
    expect(bobList.map((m) => m.id).sort()).toEqual(["b1", "b2"]);
    const carolList = await store.listForPeer("carol");
    expect(carolList).toHaveLength(0);
  });

  it("limit returns the most-recent N (boundary at end)", async () => {
    const list = await store.listForPeer("alice", { limit: 2 });
    expect(list.map((m) => m.id)).toEqual(["a4", "a5"]);
  });

  it("beforeSentAt filters older only — no inclusive boundary", async () => {
    const list = await store.listForPeer("alice", { beforeSentAt: 3000 });
    // sentAt < 3000 → a1 (1000), a2 (2000); NOT a3 (3000)
    expect(list.map((m) => m.id)).toEqual(["a1", "a2"]);
  });

  it("limit + beforeSentAt: page sits at the boundary just before cutoff", async () => {
    const list = await store.listForPeer("alice", { limit: 1, beforeSentAt: 5000 });
    expect(list.map((m) => m.id)).toEqual(["a4"]); // newest of {a1..a4}
  });

  it("reflects edits applied since insertion", async () => {
    await store.applyEdit({ targetId: "a1", editorUserId: "alice", newText: "edited", editedAt: 9000 });
    const list = await store.listForPeer("alice");
    const a1 = list.find((m) => m.id === "a1")!;
    expect(a1.text).toBe("edited");
    expect(a1.editedAt).toBe(9000);
  });

  it("reflects deletes (tombstone) applied since insertion", async () => {
    await store.applyDelete({ targetId: "a3", deleterUserId: "alice", deletedAt: 9999 });
    const list = await store.listForPeer("alice");
    const a3 = list.find((m) => m.id === "a3")!;
    expect(a3.text).toBe("");
    expect(a3.deletedAt).toBe(9999);
  });

  it("works after a fresh MessageStore on the same KV (cold cache)", async () => {
    const fresh = new MessageStore(kv);
    const list = await fresh.listForPeer("alice");
    expect(list).toHaveLength(5);
  });
});

// ── Outbox ──────────────────────────────────────────────────────────────────

describe("Outbox", () => {
  it("first attempt success removes the entry", async () => {
    const outbox = new Outbox();
    let attempts = 0;
    outbox.enqueue({
      messageId: "m1",
      peerUserId: "bob",
      ephemeral: false,
      attempt: async () => {
        attempts++;
        return new Map([["e1", "live"]]);
      },
    });
    const completed = await outbox.tick();
    expect(completed).toBe(1);
    expect(attempts).toBe(1);
    expect(outbox.size()).toBe(0);
  });

  it("idempotent on messageId", async () => {
    const outbox = new Outbox();
    outbox.enqueue({
      messageId: "m1",
      peerUserId: "bob",
      ephemeral: false,
      attempt: async () => new Map([["e1", "live"]]),
    });
    outbox.enqueue({
      messageId: "m1",
      peerUserId: "bob",
      ephemeral: false,
      attempt: async () => new Map([["e1", "live"]]),
    });
    expect(outbox.size()).toBe(1);
  });

  it("retries with backoff on errors-only outcome", async () => {
    vi.useFakeTimers();
    try {
      const outbox = new Outbox({ baseBackoffMs: 100, maxAttempts: 3 });
      let attempts = 0;
      outbox.enqueue({
        messageId: "m1",
        peerUserId: "bob",
        ephemeral: false,
        attempt: async () => {
          attempts++;
          return new Map([["e1", "error"]]);
        },
      });
      await outbox.tick();
      expect(attempts).toBe(1);
      // Backoff still pending — second tick is a no-op.
      await outbox.tick();
      expect(attempts).toBe(1);
      // Advance time past the backoff.
      vi.advanceTimersByTime(2000);
      await outbox.tick();
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after maxAttempts", async () => {
    vi.useFakeTimers();
    try {
      const outbox = new Outbox({ baseBackoffMs: 1, maxAttempts: 2 });
      outbox.enqueue({
        messageId: "m1",
        peerUserId: "bob",
        ephemeral: false,
        attempt: async () => new Map([["e1", "error"]]),
      });
      await outbox.tick();
      // computeBackoff has a 100ms floor; advance well past it.
      vi.advanceTimersByTime(500);
      await outbox.tick();
      expect(outbox.size()).toBe(0); // gave up
      expect(outbox.has("m1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires onTerminalFailure with the discarded entry", async () => {
    vi.useFakeTimers();
    try {
      const failed: string[] = [];
      const outbox = new Outbox({
        baseBackoffMs: 1,
        maxAttempts: 2,
        onTerminalFailure: (entry) => {
          failed.push(entry.messageId);
        },
      });
      outbox.enqueue({
        messageId: "m1",
        peerUserId: "bob",
        ephemeral: false,
        attempt: async () => new Map([["e1", "error"]]),
      });
      await outbox.tick();
      vi.advanceTimersByTime(500);
      await outbox.tick();
      expect(failed).toEqual(["m1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("onTerminalFailure is NOT fired on success", async () => {
    const failed: string[] = [];
    const outbox = new Outbox({
      onTerminalFailure: (entry) => {
        failed.push(entry.messageId);
      },
    });
    outbox.enqueue({
      messageId: "m1",
      peerUserId: "bob",
      ephemeral: false,
      attempt: async () => new Map([["e1", "live"]]),
    });
    await outbox.tick();
    expect(failed).toEqual([]);
  });
});

// ── TypingManager ───────────────────────────────────────────────────────────

describe("TypingManager", () => {
  let mgr: TypingManager;
  let emitted: Array<{ peer: string; state: string }>;

  beforeEach(() => {
    emitted = [];
    mgr = new TypingManager((peer, state) => emitted.push({ peer, state }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    mgr.shutdown();
    vi.useRealTimers();
  });

  it("first setTyping(true) emits started immediately", () => {
    mgr.setTyping("bob", true);
    expect(emitted).toEqual([{ peer: "bob", state: "started" }]);
  });

  it("rapid setTyping(true) is throttled — only one started in 3s", () => {
    mgr.setTyping("bob", true);
    vi.advanceTimersByTime(500);
    mgr.setTyping("bob", true);
    vi.advanceTimersByTime(500);
    mgr.setTyping("bob", true);
    expect(emitted.filter((e) => e.state === "started")).toHaveLength(1);
  });

  it("after 3s another started fires on next setTyping", () => {
    mgr.setTyping("bob", true);
    vi.advanceTimersByTime(3500);
    mgr.setTyping("bob", true);
    expect(emitted.filter((e) => e.state === "started")).toHaveLength(2);
  });

  it("auto-stops after 5s of no further setTyping", () => {
    mgr.setTyping("bob", true);
    vi.advanceTimersByTime(5500);
    expect(emitted).toEqual([
      { peer: "bob", state: "started" },
      { peer: "bob", state: "stopped" },
    ]);
  });

  it("setTyping(false) emits stopped immediately", () => {
    mgr.setTyping("bob", true);
    mgr.setTyping("bob", false);
    expect(emitted).toEqual([
      { peer: "bob", state: "started" },
      { peer: "bob", state: "stopped" },
    ]);
  });

  it("setTyping(false) when not active is a no-op", () => {
    mgr.setTyping("bob", false);
    expect(emitted).toEqual([]);
  });

  it("clearOnSend clears active typing state", () => {
    mgr.setTyping("bob", true);
    mgr.clearOnSend("bob");
    expect(emitted).toEqual([
      { peer: "bob", state: "started" },
      { peer: "bob", state: "stopped" },
    ]);
  });

  it("multiple peers tracked independently", () => {
    mgr.setTyping("bob", true);
    mgr.setTyping("carol", true);
    expect(emitted).toEqual([
      { peer: "bob", state: "started" },
      { peer: "carol", state: "started" },
    ]);
    mgr.setTyping("bob", false);
    expect(emitted[2]).toEqual({ peer: "bob", state: "stopped" });
    // carol still active
    vi.advanceTimersByTime(5500);
    expect(emitted.filter((e) => e.peer === "carol" && e.state === "stopped")).toHaveLength(1);
  });
});
