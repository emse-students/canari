/**
 * WHAT THE PAGE OF ONE LIVE (`/lives/<id>`, the link a live is shared by and the "X est en live"
 * push opens) SHOWS WHEN THE OPENING READ FAILS - the one decision, made on the refusal's TYPE
 * (`LiveRefusalError.kind`), never on a message.
 *
 * - `gone`: absent, ended, cut - and a live the reader may not see, which the server answers with the
 *   same 404 on purpose (docs/wiki/services/lives.md): the page cannot tell them apart, so its words
 *   are "over, or not available to you", never a reason.
 * - `full`: the host's viewer cap; the same "live complet" words as the viewer, with a retry.
 * - `unavailable`: removed from this live, switched off, or a refusal this build cannot act on.
 * - `retry`: the link failed (a transport failure, a seat or rate wobble): say so and offer again.
 */
import { liveFailureOutcome } from './liveViewerState';

export type LiveRouteProblem = 'gone' | 'full' | 'unavailable' | 'retry';

/** The screen for a failed opening read; the join has not happened, so a 404 is not "an end". */
export function liveRouteProblemOf(error: unknown): LiveRouteProblem {
  const outcome = liveFailureOutcome(error, false);
  if (outcome === 'retry') return 'retry';
  switch (outcome.stop.kind) {
    case 'ended':
      return 'gone';
    case 'full':
      return 'full';
    case 'unavailable':
      return outcome.stop.reason === 'not-found' ? 'gone' : 'unavailable';
    default:
      return 'unavailable';
  }
}
