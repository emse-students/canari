/**
 * Shared client logic that must stay aligned with chat-delivery
 * `POST /api/mls/commit` (epoch-gated validation).
 *
 * After producing commit bytes, OpenMLS has already advanced the local epoch by
 * one. The server stores `activeEpoch` as the epoch *after* the last accepted
 * commit. The client therefore sends `baseEpoch = localEpoch - 1` so it matches
 * the server's `activeEpoch` before the new commit is applied.
 */
export function commitBaseEpochForValidation(currentOpenMlsEpoch: number): number {
  if (!Number.isFinite(currentOpenMlsEpoch) || currentOpenMlsEpoch < 0) {
    return 0;
  }
  return Math.max(0, Math.floor(currentOpenMlsEpoch) - 1);
}
