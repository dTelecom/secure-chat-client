// Logger module — level gating, ring buffer, localStorage opt-in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogContext } from "../src/logging.js";

describe("LogContext — explicit level", () => {
  let consoleSpies: { error: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; info: ReturnType<typeof vi.spyOn>; debug: ReturnType<typeof vi.spyOn> };
  beforeEach(() => {
    consoleSpies = {
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    };
  });
  afterEach(() => {
    consoleSpies.error.mockRestore();
    consoleSpies.warn.mockRestore();
    consoleSpies.info.mockRestore();
    consoleSpies.debug.mockRestore();
  });

  it("silent: nothing reaches console; ring still captures", () => {
    const ctx = new LogContext("silent");
    const log = ctx.makeLogger("test");
    log.error("nope");
    log.warn("nope");
    log.info("nope");
    log.debug("nope");
    expect(consoleSpies.error).not.toHaveBeenCalled();
    expect(consoleSpies.warn).not.toHaveBeenCalled();
    expect(consoleSpies.info).not.toHaveBeenCalled();
    expect(consoleSpies.debug).not.toHaveBeenCalled();
    // But the ring buffer DID capture (always-on, used by getDiagnostics).
    expect(ctx.recentEvents().length).toBe(4);
  });

  it("error: only error reaches console", () => {
    const ctx = new LogContext("error");
    const log = ctx.makeLogger("test");
    log.error("err"); log.warn("warn"); log.info("info"); log.debug("debug");
    expect(consoleSpies.error).toHaveBeenCalledTimes(1);
    expect(consoleSpies.warn).not.toHaveBeenCalled();
    expect(consoleSpies.info).not.toHaveBeenCalled();
    expect(consoleSpies.debug).not.toHaveBeenCalled();
  });

  it("debug: everything reaches console with tag prefix", () => {
    const ctx = new LogContext("debug");
    const log = ctx.makeLogger("sessions");
    log.info("hello", { foo: 1 });
    expect(consoleSpies.info).toHaveBeenCalledWith("[sessions]", "hello", { foo: 1 });
  });

  it("ring buffer is bounded — oldest entries drop", () => {
    const ctx = new LogContext("silent");
    const log = ctx.makeLogger("test");
    // RING_CAP = 256
    for (let i = 0; i < 300; i++) log.info(`event-${i}`);
    const evts = ctx.recentEvents();
    expect(evts.length).toBe(256);
    // Oldest should be event-44 (first 44 fell off).
    expect(evts[0].msg).toBe("event-44");
    expect(evts[evts.length - 1].msg).toBe("event-299");
  });

  it("recentEvents(limit) returns the tail", () => {
    const ctx = new LogContext("silent");
    const log = ctx.makeLogger("test");
    for (let i = 0; i < 10; i++) log.info(`event-${i}`);
    const tail = ctx.recentEvents(3);
    expect(tail.map((e) => e.msg)).toEqual(["event-7", "event-8", "event-9"]);
  });

  it("multiple loggers from same context share the ring + level", () => {
    const ctx = new LogContext("info");
    const a = ctx.makeLogger("a");
    const b = ctx.makeLogger("b");
    a.info("from a");
    b.info("from b");
    a.debug("hidden");
    expect(consoleSpies.info).toHaveBeenCalledTimes(2);
    expect(consoleSpies.debug).not.toHaveBeenCalled();
    expect(ctx.recentEvents().map((e) => `${e.tag}:${e.msg}`)).toEqual([
      "a:from a",
      "b:from b",
      "a:hidden",
    ]);
  });
});

describe("LogContext — localStorage opt-in", () => {
  const KEY = "@dtelecom/secure-chat-client:debug";
  beforeEach(() => {
    // jsdom-less environment — vitest's default Node target. Use a fake.
    const fake: Storage = (() => {
      const m = new Map<string, string>();
      return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => { m.set(k, v); },
        removeItem: (k: string) => { m.delete(k); },
        clear: () => m.clear(),
        key: (i: number) => Array.from(m.keys())[i] ?? null,
        get length() { return m.size; },
      };
    })();
    (globalThis as { localStorage?: Storage }).localStorage = fake;
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("uses localStorage value when no explicit level", () => {
    globalThis.localStorage.setItem(KEY, "debug");
    const ctx = new LogContext();
    expect(ctx.getLevel()).toBe("debug");
  });

  it("explicit level wins over localStorage", () => {
    globalThis.localStorage.setItem(KEY, "debug");
    const ctx = new LogContext("warn");
    expect(ctx.getLevel()).toBe("warn");
  });

  it("ignores invalid level in localStorage", () => {
    globalThis.localStorage.setItem(KEY, "verbose"); // not a valid level
    const ctx = new LogContext();
    expect(ctx.getLevel()).toBe("silent");
  });

  it("defaults to silent when nothing set", () => {
    const ctx = new LogContext();
    expect(ctx.getLevel()).toBe("silent");
  });
});
