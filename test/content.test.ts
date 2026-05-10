// Content-protocol unit tests: encode/decode roundtrip, forward-compat
// drops, and factory helpers.

import { describe, expect, it } from "vitest";
import {
  CONTENT_PROTOCOL_VERSION,
  decodeEvent,
  decodeEventBytes,
  encodeEvent,
  encodeEventBytes,
  newDelete,
  newEdit,
  newRead,
  newReceived,
  newSelfEcho,
  newText,
  newTyping,
} from "../src/content/protocol.js";

describe("encode/decode roundtrip", () => {
  it("text with no replyTo", () => {
    const ev = newText("hello");
    const decoded = decodeEvent(encodeEvent(ev));
    expect(decoded).toEqual(ev);
  });

  it("text with replyTo", () => {
    const ev = newText("re: hi", "msg-abc");
    const decoded = decodeEvent(encodeEvent(ev));
    expect(decoded).toEqual(ev);
    expect(decoded?.type === "text" && decoded.replyTo).toBe("msg-abc");
  });

  it("edit", () => {
    const ev = newEdit("msg-abc", "fixed text");
    const decoded = decodeEvent(encodeEvent(ev));
    expect(decoded).toEqual(ev);
  });

  it("delete", () => {
    const ev = newDelete("msg-abc");
    const decoded = decodeEvent(encodeEvent(ev));
    expect(decoded).toEqual(ev);
  });

  it("read", () => {
    const ev = newRead("msg-xyz");
    const decoded = decodeEvent(encodeEvent(ev));
    expect(decoded).toEqual(ev);
  });

  it("received", () => {
    const ev = newReceived(["msg-1", "msg-2", "msg-3"]);
    const decoded = decodeEvent(encodeEvent(ev));
    expect(decoded).toEqual(ev);
  });

  it("typing", () => {
    const a = newTyping("started");
    const b = newTyping("stopped");
    expect(decodeEvent(encodeEvent(a))).toEqual(a);
    expect(decodeEvent(encodeEvent(b))).toEqual(b);
  });

  it("bytes form roundtrips identically", () => {
    const ev = newText("bytes");
    const decoded = decodeEventBytes(encodeEventBytes(ev));
    expect(decoded).toEqual(ev);
  });
});

describe("forward-compat drops on unknown / future shapes", () => {
  it("drops unknown type silently", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "abc",
      type: "unknownFutureType",
      clientSentAt: 1,
      payload: { whatever: true },
    });
    expect(decodeEvent(raw)).toBeNull();
  });

  it("drops higher protocol version", () => {
    const raw = JSON.stringify({
      v: CONTENT_PROTOCOL_VERSION + 1,
      id: "abc",
      type: "text",
      clientSentAt: 1,
      text: "hi",
    });
    expect(decodeEvent(raw)).toBeNull();
  });

  it("drops malformed JSON", () => {
    expect(decodeEvent("not-json")).toBeNull();
  });

  it("drops missing required fields", () => {
    expect(decodeEvent(JSON.stringify({ v: 1, type: "text" }))).toBeNull();
    expect(decodeEvent(JSON.stringify({ v: 1, id: "x", type: "text", clientSentAt: 1 }))).toBeNull(); // no .text
  });

  it("drops typing with bad state", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "x",
      type: "typing",
      clientSentAt: 1,
      state: "wat",
    });
    expect(decodeEvent(raw)).toBeNull();
  });

  it("drops received with non-string ids", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "x",
      type: "received",
      clientSentAt: 1,
      ids: ["good", 42 as unknown as string],
    });
    expect(decodeEvent(raw)).toBeNull();
  });
});

describe("encodeEvent input validation", () => {
  it("throws on missing id/type", () => {
    expect(() =>
      encodeEvent({
        v: 1,
        id: "",
        type: "text",
        clientSentAt: 1,
        text: "hi",
      } as unknown as Parameters<typeof encodeEvent>[0]),
    ).toThrow();
  });
});

describe("selfEcho (multi-device sync) codec", () => {
  it("roundtrips a wrapped text event", () => {
    const inner = newText("hi");
    const echo = newSelfEcho("bob", inner);
    const decoded = decodeEvent(encodeEvent(echo));
    expect(decoded).toEqual(echo);
    expect(decoded?.type === "selfEcho" && decoded.originalPeer).toBe("bob");
    expect(decoded?.type === "selfEcho" && decoded.original.type).toBe("text");
  });

  it("roundtrips wrapped edit / delete / read events", () => {
    for (const inner of [
      newEdit("target-1", "edited"),
      newDelete("target-1"),
      newRead("target-2"),
    ]) {
      const echo = newSelfEcho("bob", inner);
      const decoded = decodeEvent(encodeEvent(echo));
      expect(decoded).toEqual(echo);
    }
  });

  it("drops selfEcho whose inner type is non-syncable (typing)", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "x",
      type: "selfEcho",
      clientSentAt: 1,
      originalPeer: "bob",
      original: { v: 1, id: "y", type: "typing", clientSentAt: 1, state: "started" },
    });
    expect(decodeEvent(raw)).toBeNull();
  });

  it("drops selfEcho whose inner type is non-syncable (received)", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "x",
      type: "selfEcho",
      clientSentAt: 1,
      originalPeer: "bob",
      original: { v: 1, id: "y", type: "received", clientSentAt: 1, ids: ["a"] },
    });
    expect(decodeEvent(raw)).toBeNull();
  });

  it("drops selfEcho with missing originalPeer", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "x",
      type: "selfEcho",
      clientSentAt: 1,
      original: { v: 1, id: "y", type: "text", clientSentAt: 1, text: "hi" },
    });
    expect(decodeEvent(raw)).toBeNull();
  });

  it("drops selfEcho with malformed inner event", () => {
    const raw = JSON.stringify({
      v: 1,
      id: "x",
      type: "selfEcho",
      clientSentAt: 1,
      originalPeer: "bob",
      original: { v: 1, id: "y", type: "text", clientSentAt: 1 }, // no .text
    });
    expect(decodeEvent(raw)).toBeNull();
  });
});
