/**
 * TEMPORARY INSTRUMENTATION - WP-FALSELOSS-2. DELETE THIS FILE once the cause is settled.
 *
 * It exists to answer ONE question with a measurement instead of an argument: does the off-thread
 * catch-up session (`WebMlsService.createDecryptSession`) rewind this device's OWN send ratchet?
 *
 * The suspected sequence, which every line below is shaped to confirm or refute:
 *
 *   1. The catch-up takes the MLS lock and SNAPSHOTS the client.
 *   2. `sendMessage` does NOT take that lock, so a send during the window advances the ratchet of
 *      the LIVE client - the snapshot knows nothing about it.
 *   3. `finish()` reloads the client from the worker's state, derived from that snapshot.
 *   4. `swapClientMonotonic` compares EPOCHS only, so a generation that moved inside one epoch is
 *      invisible to it and the swap is adopted.
 *   5. The next send re-emits an already-spent generation. The receiver refuses it with
 *      `SecretReuseError`, which is reported - correctly - as "the sender's ratchet rewound".
 *
 * Step 4 is why an epoch guard cannot see this: it is evidence for the question it was written to
 * answer (a stale snapshot clobbering a newer epoch) and for no other.
 *
 * The decisive line is `[REWIND-TRACE] session finish` with `sendsDuringWindow` > 0 and
 * `swapped=true`. The fingerprints it names are the frames whose generations are about to be
 * re-issued, so they should turn up on a PEER as the `frame ...` of a `LOST frame` line.
 */

import { frameFingerprint } from './inboundFrameLedger';
import type { FrameDelivery } from './frameDelivery';

/** One outbound frame observed while a catch-up window was open. */
interface TracedSend {
  groupId: string;
  fingerprint: string;
  bytes: number;
  silent: boolean;
  durable: boolean;
}

/**
 * Sends observed since the currently open catch-up window began.
 *
 * The MLS client is GLOBAL while a decrypt session is per-group, so a send to ANY group during the
 * window is rewound by the swap. Scoping this per group would therefore under-report.
 */
let sendsDuringWindow: TracedSend[] = [];

/** Depth of open catch-up windows. Nothing guarantees only one is ever open. */
let openWindows = 0;

/** Monotonic id so a finish line can be matched to its own open line in an interleaved log. */
let nextWindowId = 1;

/** Records and logs one outbound frame, and returns its fingerprint for the caller's own logging. */
export function traceSend(
  groupId: string,
  ciphertext: Uint8Array,
  delivery: FrameDelivery
): string {
  const fingerprint = frameFingerprint(ciphertext);
  const entry: TracedSend = {
    groupId,
    fingerprint,
    bytes: ciphertext.length,
    silent: delivery.silent,
    durable: delivery.durable,
  };
  if (openWindows > 0) sendsDuringWindow.push(entry);
  // LOGGED ONLY INSIDE A WINDOW, because only a send inside one can be rewound. Outside, this line
  // said `duringCatchUp=false` about the entirely ordinary case and fired on EVERY send: seventy-five
  // of the eighty-nine unexplained lines in the MSG run of 2026-08-14, drowning the fourteen that
  // meant something. A trace that fires on the normal path is a trace nobody reads, and this one is
  // here to be read exactly once - when a send really does race a catch-up.
  if (openWindows > 0) {
    console.debug(
      `[REWIND-TRACE] send group=${groupId.slice(0, 8)}… frame=${fingerprint} bytes=${ciphertext.length} silent=${delivery.silent} durable=${delivery.durable} duringCatchUp=true`
    );
  }
  return fingerprint;
}

/** Marks the start of a catch-up window (snapshot taken). Returns the window id for the finish call. */
export function traceSessionOpen(groupId: string, mode: 'worker' | 'sequential'): number {
  const id = nextWindowId++;
  openWindows++;
  if (openWindows === 1) sendsDuringWindow = [];
  console.debug(
    `[REWIND-TRACE] session open #${id} group=${groupId.slice(0, 8)}… mode=${mode} openWindows=${openWindows}`
  );
  return id;
}

/**
 * How a catch-up window ended. THREE outcomes, not two.
 *
 * `not-attempted` is its own case and conflating it with `refused` is not a wording quibble: a
 * session that decrypted nothing (`usedWorker === false`) never asks for a swap at all, and reporting
 * that as a refusal sends the reader looking for a guard that never fired. Measured 2026-08-14 - a
 * clean MSG-1b reported `swap refused` on a receiver where neither `swapClientMonotonic` nor
 * `installUnlessOvertaken` had logged anything, because there was nothing to install.
 */
export type SwapOutcome = 'installed' | 'refused' | 'not-attempted';

/**
 * Marks the end of a catch-up window.
 *
 * `outcome` is what actually happened to the candidate state - not what was requested - because the
 * whole question is whether a state that predates those sends was installed over them.
 */
export function traceSessionFinish(id: number, groupId: string, outcome: SwapOutcome): void {
  openWindows = Math.max(0, openWindows - 1);
  const observed = sendsDuringWindow;
  if (openWindows === 0) sendsDuringWindow = [];
  const frames = observed.map((s) => `${s.fingerprint}(${s.bytes}B,silent=${s.silent})`).join(' ');
  const verdict =
    outcome === 'installed'
      ? observed.length > 0
        ? 'RATCHET REWIND: state predating these sends was installed over them'
        : 'clean swap, no send in the window'
      : outcome === 'refused'
        ? 'swap REFUSED by a guard, live client kept'
        : 'nothing to install - the session decrypted no page';
  console.debug(
    `[REWIND-TRACE] session finish #${id} group=${groupId.slice(0, 8)}… outcome=${outcome} sendsDuringWindow=${observed.length} - ${verdict}${frames ? ` [${frames}]` : ''}`
  );
}
