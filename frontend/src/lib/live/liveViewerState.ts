/**
 * WHAT THE LIVE VIEWER SHOWS, AND THE ONE DECISION FROM A FAILURE TO A SCREEN.
 *
 * A refusal is already typed at the throw (`LiveRefusalError.kind`, `./api`); this file decides, once,
 * which screen each kind leads to, so the player and the component never re-derive it. The three the
 * brief forbids confusing stay apart: `full` is the "live complet" screen, `seats-unavailable` and
 * `rate-limited` are a reconnect - never "complet".
 */

import { LiveRefusalError } from './api';
import { isTransportFailure } from '$lib/utils/transportFailure';

/** Why the viewer is reconnecting: our link or the server (`network`), or the broadcaster's. */
export type LiveReconnectReason = 'network' | 'broadcaster';

/** Why a live cannot be shown: every one is the same neutral "live indisponible" screen. */
export type LiveUnavailableReason =
  | 'not-found'
  | 'removed'
  | 'disabled'
  | 'refused'
  | 'unsupported'
  | 'undecryptable'
  | 'playback';

/** The viewer's state, as the screen draws it. */
export type LiveViewerState =
  | { kind: 'connecting' }
  | { kind: 'playing' }
  | { kind: 'reconnecting'; reason: LiveReconnectReason }
  | { kind: 'full'; viewerCap: number | null }
  | { kind: 'ended' }
  | { kind: 'unavailable'; reason: LiveUnavailableReason };

/**
 * What a failure means for the viewer: a state to stop on, or `retry` (the same step again, after a
 * backoff, while the screen says "reconnecting").
 *
 * `joined` says whether this viewer has already played the live. A `404 LIVE_NOT_FOUND` after that
 * is the END: the broadcaster's end deletes the row at once (L3, docs/wiki/services/lives.md, "The
 * API contract"), so a viewer polling a second later is told "not found", not `410`. Before the
 * join it is what it says - absent, invisible or blocked - and the screen is the neutral one.
 */
export function liveFailureOutcome(
  error: unknown,
  joined: boolean
): { stop: LiveViewerState } | 'retry' {
  if (error instanceof LiveRefusalError) {
    switch (error.kind) {
      case 'full':
        return { stop: { kind: 'full', viewerCap: error.viewerCap } };
      case 'ended':
        return { stop: { kind: 'ended' } };
      case 'not-found':
        return { stop: joined ? { kind: 'ended' } : { kind: 'unavailable', reason: 'not-found' } };
      case 'removed':
        return { stop: { kind: 'unavailable', reason: 'removed' } };
      case 'disabled':
        return { stop: { kind: 'unavailable', reason: 'disabled' } };
      case 'seats-unavailable':
      case 'rate-limited':
      case 'unavailable':
      case 'retry-segment':
        return 'retry';
      case 'out-of-order':
      case 'refused':
        return { stop: { kind: 'unavailable', reason: 'refused' } };
    }
  }
  if (isTransportFailure(error)) return 'retry';
  // Anything else is a defect of ours (a thrown TypeError in a parser...): never retried in a loop.
  return { stop: { kind: 'unavailable', reason: 'refused' } };
}

/** The wait before the n-th retry in a row (1, 2, ...): 1 s doubling, at most 8 s. */
export function liveRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 8_000);
}

/** Whether a state is final: the player has stopped and only the reader can start it again. */
export function isTerminalLiveState(state: LiveViewerState): boolean {
  return state.kind === 'full' || state.kind === 'ended' || state.kind === 'unavailable';
}
