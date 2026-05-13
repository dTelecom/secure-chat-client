// Outbox — queues outbound chatSend frames for retry on transient failure.
// Idempotent at the wire level via envelopeUuid: re-sending the same uuid
// is harmless because the server-side store dedupes, the receiver's
// session has Olm replay protection, and the in-flight ACK map keys by
// uuid so a duplicate just signals once.
//
// In-memory only for v1. Survives nothing across reload — that's fine for
// the typical browser threat model where a tab close means the user is
// done. KV-backed durability is a future hardening item.

export interface OutboxEntry {
  messageId: string;
  peerUserId: string;
  ephemeral: boolean;
  /** Function that performs the actual send — returns a per-target outcome
   *  set keyed by envelopeUuid. */
  attempt: () => Promise<Map<string, "live" | "stored" | "dropped" | "error">>;
  attempts: number;
  nextRetryAt: number;
}

export interface OutboxOptions {
  /** Max attempts before giving up (default 5). */
  maxAttempts?: number;
  /** Base backoff (ms) — actual is base * 2^attempts ± 20% jitter. */
  baseBackoffMs?: number;
  /** Fired once when an entry has exhausted its retry budget and is being
   *  discarded. The SDK uses this to write `status: "failed"` to the stored
   *  message and emit a `messageSendFailed` event to the app. */
  onTerminalFailure?: (entry: OutboxEntry) => void;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF = 500;

/**
 * Outbox processes a queue of pending sends with exponential backoff.
 * Caller drives the loop via `enqueue` + the returned per-attempt
 * outcome — Outbox itself doesn't run a goroutine, it's just a state
 * machine. The SDK calls `tick()` opportunistically (on connect, on
 * scheduled timer) and `enqueue()` on each new send.
 */
export class Outbox {
  private queue: OutboxEntry[] = [];
  private inflightIds = new Set<string>();
  private opts: {
    maxAttempts: number;
    baseBackoffMs: number;
    onTerminalFailure?: (entry: OutboxEntry) => void;
  };

  constructor(opts: OutboxOptions = {}) {
    this.opts = {
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      baseBackoffMs: opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF,
      ...(opts.onTerminalFailure ? { onTerminalFailure: opts.onTerminalFailure } : {}),
    };
  }

  /**
   * Enqueue a send attempt. Idempotent on messageId — a second enqueue
   * with the same id is a no-op (returns the existing entry's promise).
   */
  enqueue(entry: Omit<OutboxEntry, "attempts" | "nextRetryAt">): void {
    if (this.inflightIds.has(entry.messageId)) return;
    this.inflightIds.add(entry.messageId);
    this.queue.push({ ...entry, attempts: 0, nextRetryAt: 0 });
  }

  /**
   * Process the queue once. Sends due-now entries; reschedules failures
   * with backoff. Returns the number of entries that completed (success
   * or terminal failure) on this tick.
   */
  async tick(): Promise<number> {
    const now = Date.now();
    let completed = 0;
    const stillPending: OutboxEntry[] = [];
    for (const entry of this.queue) {
      if (entry.nextRetryAt > now) {
        stillPending.push(entry);
        continue;
      }
      entry.attempts++;
      let outcomes: Map<string, "live" | "stored" | "dropped" | "error">;
      try {
        outcomes = await entry.attempt();
      } catch {
        outcomes = new Map();
      }
      // Success = at least one target stored or live. Errors-only means retry.
      const anyOk = Array.from(outcomes.values()).some((s) => s === "live" || s === "stored");
      if (anyOk) {
        this.inflightIds.delete(entry.messageId);
        completed++;
        continue;
      }
      if (entry.attempts >= this.opts.maxAttempts) {
        this.inflightIds.delete(entry.messageId);
        completed++;
        try {
          this.opts.onTerminalFailure?.(entry);
        } catch {
          // Listener errors must not break the outbox loop.
        }
        continue;
      }
      entry.nextRetryAt = now + this.computeBackoff(entry.attempts);
      stillPending.push(entry);
    }
    this.queue = stillPending;
    return completed;
  }

  size(): number {
    return this.queue.length;
  }

  /** Test helper. */
  has(messageId: string): boolean {
    return this.inflightIds.has(messageId);
  }

  private computeBackoff(attempt: number): number {
    const base = this.opts.baseBackoffMs * 2 ** (attempt - 1);
    const jitter = base * (0.4 * Math.random() - 0.2); // ±20%
    return Math.max(100, Math.floor(base + jitter));
  }
}
