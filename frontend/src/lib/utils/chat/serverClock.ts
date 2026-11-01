/**
 * The newest instant THE SERVER ITSELF has stated to this session: a delivered frame's
 * `queued_message.createdAt`, the `receivedAt` an own send answered.
 *
 * WHY IT EXISTS. Since 2026-10-31 a DM or group read mark is on the server's clock
 * (`readMarkTarget`), taken from the rows held - and a row's `serverTimestamp` may have come from a
 * HISTORY BUNDLE, written by the member who relayed it. Bundle times are vetted on ingest
 * (`vettedBundleServerTime`), but a row stored by an older build was not, and the merge of a mark is
 * `max`, so one row dated 2100 would mark every later message read, for good. Clamping the target to
 * what the server has said bounds it by a fact no member controls.
 *
 * In memory, per session: it only ever moves forward, and the first frame or send of a session
 * sets it. Before either, the target is clamped by the rows held alone (`readMarkTarget`).
 */
let highest = 0;

/** Notes a time the server stated directly (ms). Ignores anything that is not a positive number. */
export function noteServerTime(at: number | undefined): void {
  if (typeof at === 'number' && Number.isFinite(at) && at > highest) highest = at;
}

/** The newest server-stated instant this session, 0 when the server has stated none yet. */
export function serverTimeSeen(): number {
  return highest;
}

/** Test seam: forget what the session saw. */
export function resetServerClockForTests(): void {
  highest = 0;
}
