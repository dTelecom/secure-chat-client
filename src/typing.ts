// TypingManager — debounces user "typing" signals into ephemeral
// `started`/`stopped` events. The SDK calls `setTyping(peerId, true)`
// on every keystroke; this layer:
//
//   - emits `started` at most once per 3s while typing
//   - auto-emits `stopped` after 5s of no further setTyping(true)
//   - emits `stopped` immediately when setTyping is called with false
//   - emits `stopped` on `clearOnSend(peerId)` (the SDK's send path)

const STARTED_REFRESH_MS = 3_000;
const AUTO_STOPPED_AFTER_MS = 5_000;

export type TypingEmitter = (
  peerUserId: string,
  state: "started" | "stopped",
) => void;

interface PeerState {
  /** When did we last emit a `started`? Used to throttle. */
  lastStartedAt: number;
  /** Pending auto-stop timer id. */
  autoStopTimer: ReturnType<typeof setTimeout> | null;
  /** Are we currently in the "started" state from this peer's perspective? */
  isActive: boolean;
}

export class TypingManager {
  private peers = new Map<string, PeerState>();

  constructor(private emit: TypingEmitter) {}

  /**
   * Called by the SDK on every keystroke change.
   * `isTyping=true` means "user is typing now"; `false` means "user
   * explicitly stopped (cleared input or blurred)".
   */
  setTyping(peerUserId: string, isTyping: boolean): void {
    const now = Date.now();
    const state = this.peers.get(peerUserId);
    if (!isTyping) {
      // Explicit stop. Emit only if we previously emitted started.
      if (state?.isActive) {
        this.cancelAutoStop(state);
        state.isActive = false;
        this.emit(peerUserId, "stopped");
      }
      return;
    }

    if (!state) {
      const fresh: PeerState = {
        lastStartedAt: now,
        autoStopTimer: null,
        isActive: true,
      };
      this.peers.set(peerUserId, fresh);
      this.scheduleAutoStop(peerUserId, fresh);
      this.emit(peerUserId, "started");
      return;
    }

    // Coming out of stopped (auto-stop or clearOnSend) — emit a fresh
    // "started" unconditionally; the throttle only suppresses while a
    // continuous typing run is in progress.
    if (!state.isActive) {
      state.isActive = true;
      state.lastStartedAt = now;
      this.scheduleAutoStop(peerUserId, state);
      this.emit(peerUserId, "started");
      return;
    }

    // Continuous typing run — refresh the auto-stop timer; only re-emit
    // started if 3s has elapsed since the last started.
    this.cancelAutoStop(state);
    this.scheduleAutoStop(peerUserId, state);
    if (now - state.lastStartedAt >= STARTED_REFRESH_MS) {
      state.lastStartedAt = now;
      this.emit(peerUserId, "started");
    }
  }

  /**
   * Called by the SDK when it actually sends a (non-typing) message to
   * this peer — closes any in-progress typing state silently.
   */
  clearOnSend(peerUserId: string): void {
    const state = this.peers.get(peerUserId);
    if (!state || !state.isActive) return;
    this.cancelAutoStop(state);
    state.isActive = false;
    this.emit(peerUserId, "stopped");
  }

  /** Tear down all timers (called on chat.disconnect()). */
  shutdown(): void {
    for (const state of this.peers.values()) {
      this.cancelAutoStop(state);
    }
    this.peers.clear();
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private scheduleAutoStop(peerUserId: string, state: PeerState): void {
    state.autoStopTimer = setTimeout(() => {
      state.autoStopTimer = null;
      if (!state.isActive) return;
      state.isActive = false;
      this.emit(peerUserId, "stopped");
    }, AUTO_STOPPED_AFTER_MS);
  }

  private cancelAutoStop(state: PeerState): void {
    if (state.autoStopTimer) {
      clearTimeout(state.autoStopTimer);
      state.autoStopTimer = null;
    }
  }
}
