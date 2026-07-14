import type { IMlsService } from '$lib/mls-client/IMlsService';

/**
 * Bounded backoff (ms) for re-soliciting a history bundle after a fresh join. Kept short enough to
 * ride out a peer that is briefly away, bounded so a group whose only other member stays offline
 * does not solicit forever.
 */
const RETRY_DELAYS_MS = [30_000, 90_000, 180_000];

type PendingSolicit = { timers: ReturnType<typeof setTimeout>[] };

/** In-memory registry of in-flight history solicitations, keyed by groupId. */
const pending = new Map<string, PendingSolicit>();

/**
 * Solicits the pre-join history bundle from one online member after this device freshly joined
 * `groupId` (via an external commit OR a Welcome). Both join paths land the device at the current
 * epoch WITHOUT the pre-join history it cannot decrypt on its own, so it must ask a member to
 * re-encrypt and resend it.
 *
 * Best-effort with bounded, receipt-driven retries. The delivery service picks a single online
 * responder per call, so re-sending on a backoff rotates past a peer that holds its WebSocket while
 * backgrounded (frozen-online: `redis.exists` is true but the app cannot process the frame) and
 * cannot answer. Retries stop as soon as a `history_bundle` actually arrives
 * (`noteHistoryBundleReceived`). The bundle receiver deduplicates by message id, so a redundant
 * resend is harmless.
 *
 * Inherent liveness limit: if the ONLY other member stays offline/backgrounded for the whole
 * window, no responder exists and the history arrives only once a member is genuinely online again
 * and the device re-solicits (e.g. on its next session).
 */
export function solicitHistory(
  mlsService: Pick<IMlsService, 'sendHistoryRequest'>,
  groupId: string,
  log: (msg: string) => void,
  delaysMs: number[] = RETRY_DELAYS_MS
): void {
  // Restart cleanly if a prior solicitation for this group is still in flight.
  cancelHistorySolicit(groupId);
  const entry: PendingSolicit = { timers: [] };
  pending.set(groupId, entry);

  const fire = (attempt: number): Promise<void> =>
    mlsService
      .sendHistoryRequest(groupId)
      .then(() => log(`[HISTORY_REQ] solicit attempt ${attempt} for ${groupId.slice(0, 8)}...`))
      .catch(() => {});

  void fire(0);
  delaysMs.forEach((delay, i) => {
    const timer = setTimeout(() => void fire(i + 1), delay);
    entry.timers.push(timer);
  });
}

/** Cancels any pending retries for `groupId` (bundle arrived, or a fresh solicitation supersedes). */
export function cancelHistorySolicit(groupId: string): void {
  const entry = pending.get(groupId);
  if (!entry) return;
  for (const timer of entry.timers) clearTimeout(timer);
  pending.delete(groupId);
}

/** Signals that a history_bundle was received for `groupId`, so we stop soliciting it. */
export function noteHistoryBundleReceived(groupId: string): void {
  cancelHistorySolicit(groupId);
}

/** Cancels every pending solicitation (session teardown / test cleanup). */
export function cancelAllHistorySolicit(): void {
  for (const groupId of [...pending.keys()]) cancelHistorySolicit(groupId);
}
