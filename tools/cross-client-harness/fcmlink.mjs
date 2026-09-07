/**
 * THE PUSH TRANSPORT IS A PRECONDITION OF EVERY ROW THAT WAITS ON A NOTIFICATION.
 *
 * ## What this file was written after
 *
 * On 2026-09-07 four verdicts - NOTIF-9 and NOTIF-11, twice each - recorded FAIL with
 * `notifiedInMs: null` over an app that was innocent. Everything a check could reach said the phone
 * was ready: the app on the Doze whitelist and in standby bucket 5 (EXEMPTED), `deviceidle` ACTIVE,
 * `ping` at 24 ms, the FCM token in `push_token` written by the app ITSELF half an hour earlier, and
 * the delivery service logging `FCM sent` with no exception - Google's API had ACCEPTED all six
 * messages. The device's connection to Google was ESTABLISHED the whole time and carried none of
 * them. Forcing Play services onto a NEW connection delivered the entire backlog (the sends carry
 * `ttl: 24h`) within five seconds.
 *
 * ## The board had been saying it for hours, and nobody had a name for it
 *
 *     00:34 NOTIF-10 (cuts the radios)  -> 00:51 NOTIF-4 PASS, 00:53 NOTIF-4b PASS,
 *                                          00:56 NOTIF-9 FAIL, 01:00 NOTIF-11 FAIL
 *     01:11 NOTIF-10 (cuts them again)  -> 01:20 NOTIF-9 PASS,
 *                                          01:24 NOTIF-11 FAIL, 01:32 NOTIF-11 FAIL
 *
 * NOTIF-10 is the only row that cuts the radios, so NOTIF-10 REPAIRED the link as a side effect of
 * its own scenario. The row after it passed. The rows after THAT failed. Two full cycles of that
 * shape, read as a product regression both times.
 *
 * ## So the link is established BEFORE a row, never diagnosed after it
 *
 * The fact was available and was learnt by failing instead, which is the one thing this harness is
 * not allowed to do. A push row over a dead transport is not a weaker measurement of Canari, it is
 * a measurement of Google - so a row that cannot get a link REFUSES rather than recording a verdict
 * about an app it never reached.
 *
 * This repairs the BENCH and never the product: Canari does not own this transport, and the repair
 * is RECORDED (`fcmLinkMs`) so that a phase whose every row needed one is saying something about the
 * handset that no PASS would otherwise carry.
 */
import { refreshFcmLink } from './phone.mjs';
import { record, exitOnRecorded } from './results.mjs';

/**
 * Renews the phone's FCM link and proves it new, or records `SETUP-FAILED` for `rowId` and exits.
 *
 * @param {string} rowId the row about to be measured - the one whose verdict a dead link would have
 *   falsified, and therefore the one the refusal is written against
 * @param {(s: string) => void} [stage] the runner's own progress reporter
 * @returns {Promise<{before: string|null, after: string|null, tookMs: number}>} on success only;
 *   the failing path does not return
 */
export async function requireFreshFcmLink(rowId, stage = () => {}) {
  stage('renewing the phone FCM link - a push row cannot measure the app over a dead one');
  const link = await refreshFcmLink();
  if (!link.failed) {
    stage(`FCM link renewed in ${link.tookMs}ms (${link.before ?? 'none'} -> ${link.after})`);
    return link;
  }
  stage(`THE FCM LINK DID NOT COME BACK (${link.before} unchanged) - refusing to measure`);
  record(rowId, 'SETUP-FAILED', { fcmLink: link });
  exitOnRecorded();
  // Unreachable: `exitOnRecorded` calls `process.exit`. Named so a reader does not look for a path
  // in which this function returns a link it could not get.
  throw new Error('unreachable');
}
