/**
 * Reports a shared promise's rejection ONCE, however many callers await it.
 *
 * Several callers can be handed the SAME promise - every Welcome folded into one queued restore
 * (`useConversations`' `loadAndRestoreConversations`) awaits one run - and each used to log its
 * failure, so one failed restore wrote N identical warnings. The first caller to report a given
 * promise logs; the others still wait for it to settle, and say nothing more, because the line they
 * would write is already there. Keyed by the promise's identity, which is the only thing that says
 * two rejections are one failure - never by the error's text.
 */
const reported = new WeakSet<Promise<unknown>>();

/**
 * Awaits `promise`; on rejection calls `report` with the reason, unless an earlier call already
 * reported this same promise. Never rejects.
 */
export async function reportRejectionOnce(
  promise: Promise<unknown>,
  report: (reason: unknown) => void
): Promise<void> {
  const first = !reported.has(promise);
  reported.add(promise);
  try {
    await promise;
  } catch (e) {
    if (first) report(e);
  }
}
