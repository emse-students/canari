import { finishJoinAskWorkInFlight } from './utils/join-ask-announce';
import { PUSH_DELIVERY_RECORDER } from './utils/push-delivery-records';

/**
 * What a retiring replica still owes once its last request was answered - the work `main.ts` hands
 * `drainOnSigterm` - in order: the join-ask announcements started after an answer (which may push,
 * and so hand the push delivery record more), then the push delivery record itself, which first SAYS
 * what is not yet written and then waits for its writer (`PushDeliveryRecorder.drainForExit`).
 */
export async function finishWorkOwedBeforeExit(): Promise<void> {
  await finishJoinAskWorkInFlight();
  await PUSH_DELIVERY_RECORDER.drainForExit();
}
