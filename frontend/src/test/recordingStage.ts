/**
 * Test double of the platform's ONE-call stage: the commit is staged and recorded with the intent
 * it was handed in the same call (`mls-core/src/pending_submission.rs`), and
 * `BaseMlsService.runCommitTransaction` composes its request from that record.
 *
 * A test that drives `runCommitTransaction` with a stand-in stage wraps it here and hands the
 * returned `pendingSubmission` to its context, so the request is built the way the real platform
 * makes it build it - not from a stub that answers whatever the test happens to expect.
 */
import type { PendingSubmissionRead } from '$lib/mls-client/commitSubmission';

/** What a stage returns that its record keeps. */
interface StageOutput {
  commit: Uint8Array;
  groupInfo: Uint8Array;
  welcome?: Uint8Array;
  addedIndices?: number[];
}

/** `epochOf` reads the epoch the commit is staged on - the group's epoch BEFORE the stage. */
export function recordingStage(epochOf: () => number | Promise<number>) {
  let read: PendingSubmissionRead = { status: 'none' };
  return {
    /** What the state says of the last staged commit's record. */
    pendingSubmission: async (): Promise<PendingSubmissionRead> => read,
    /** `stage`, recording what it returns with the intent it was handed, as one call. */
    wrap<R extends StageOutput>(
      stage: (intent: Uint8Array) => Promise<R>
    ): (intent: Uint8Array) => Promise<R> {
      return async (intent) => {
        const baseEpoch = await epochOf();
        const out = await stage(intent);
        read = {
          status: 'recorded',
          record: {
            intent,
            baseEpoch,
            commit: out.commit,
            groupInfo: out.groupInfo,
            ...(out.welcome ? { welcome: out.welcome } : {}),
            addedIndices: out.addedIndices ?? [],
          },
        };
        return out;
      };
    },
  };
}
