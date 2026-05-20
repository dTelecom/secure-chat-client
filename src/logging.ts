// Lightweight diagnostic logger for the SDK. Off by default; opt-in via:
//   - ConnectOptions.debug: "error" | "warn" | "info" | "debug"
//   - localStorage["@dtelecom/secure-chat-client:debug"] = "<level>"
//
// Always-on small ring buffer keeps the last N events for
// `chat.getDiagnostics()` to surface in bug reports — independent of
// whether console logging is enabled. Bounded so it can't grow without
// limit on a long-running session.

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const ALL_LEVELS: LogLevel[] = ["silent", "error", "warn", "info", "debug"];

const LOCAL_STORAGE_KEY = "@dtelecom/secure-chat-client:debug";

/** Public logger surface. One per category/tag. */
export interface Logger {
  error(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
}

/** One recorded event in the ring buffer. */
export interface LogEvent {
  ts: number;
  level: Exclude<LogLevel, "silent">;
  tag: string;
  msg: string;
  ctx?: Record<string, unknown>;
}

/**
 * Per-SDK-instance log context. Carries the resolved level + the shared
 * ring buffer. `makeLogger(tag)` mints a Logger that writes to console
 * (if level permits) AND to the ring buffer (always).
 */
export class LogContext {
  private level: LogLevel;
  private ring: LogEvent[] = [];
  private static readonly RING_CAP = 256;

  constructor(explicit?: LogLevel) {
    this.level = resolveLevel(explicit);
  }

  /** Current effective level. */
  getLevel(): LogLevel {
    return this.level;
  }

  /** Last N events, oldest first. Used by chat.getDiagnostics(). */
  recentEvents(limit = LogContext.RING_CAP): LogEvent[] {
    if (limit >= this.ring.length) return this.ring.slice();
    return this.ring.slice(this.ring.length - limit);
  }

  /** Build a logger for a specific category. */
  makeLogger(tag: string): Logger {
    return {
      error: (msg, ctx) => this.emit("error", tag, msg, ctx),
      warn: (msg, ctx) => this.emit("warn", tag, msg, ctx),
      info: (msg, ctx) => this.emit("info", tag, msg, ctx),
      debug: (msg, ctx) => this.emit("debug", tag, msg, ctx),
    };
  }

  private emit(
    level: Exclude<LogLevel, "silent">,
    tag: string,
    msg: string,
    ctx?: Record<string, unknown>,
  ): void {
    const entry: LogEvent = ctx
      ? { ts: Date.now(), level, tag, msg, ctx }
      : { ts: Date.now(), level, tag, msg };
    // Always record to the ring (cheap; getDiagnostics relies on this).
    this.ring.push(entry);
    if (this.ring.length > LogContext.RING_CAP) {
      this.ring.shift();
    }
    // Console emit gated on level. `console.debug` is muted by default
    // in many browsers — that's the right behavior for production where
    // someone forgot to set the level back to silent.
    if (LEVEL_RANK[this.level] < LEVEL_RANK[level]) return;
    const prefix = `[${tag}]`;
    switch (level) {
      case "error":
        if (ctx) console.error(prefix, msg, ctx);
        else console.error(prefix, msg);
        return;
      case "warn":
        if (ctx) console.warn(prefix, msg, ctx);
        else console.warn(prefix, msg);
        return;
      case "info":
        if (ctx) console.info(prefix, msg, ctx);
        else console.info(prefix, msg);
        return;
      case "debug":
        if (ctx) console.debug(prefix, msg, ctx);
        else console.debug(prefix, msg);
        return;
    }
  }
}

/**
 * Resolve the effective log level. Explicit ConnectOptions.debug wins;
 * else check localStorage; else default to "silent".
 *
 * The localStorage path is meant for in-the-field debugging: an FE dev
 * looking at a deployed app can run
 *   localStorage.setItem("@dtelecom/secure-chat-client:debug", "debug")
 * in devtools, reload, and immediately see SDK internals — no
 * code change, no redeploy.
 */
function resolveLevel(explicit?: LogLevel): LogLevel {
  if (explicit) return explicit;
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return "silent";
    const raw = ls.getItem(LOCAL_STORAGE_KEY);
    if (raw && (ALL_LEVELS as string[]).includes(raw)) {
      return raw as LogLevel;
    }
  } catch {
    // localStorage may throw in private mode / not-available
  }
  return "silent";
}

/** Off-instance helper for tests that don't need a context. */
export function silentLogger(): Logger {
  return {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
  };
}

const noop = (): void => {};
