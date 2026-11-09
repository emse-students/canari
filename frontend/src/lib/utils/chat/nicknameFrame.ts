import { applyNickname, boundedNicknameAt } from '$lib/utils/users/conversationNicknames.svelte';
import { normalizeNickname } from '$lib/utils/users/nicknameRules';

/** What one `nickname` frame did to the register. */
export type NicknameFrameOutcome = 'applied' | 'stale' | 'refused';

/**
 * Applies one `nickname` MLS system frame - live or replayed from the shared log - to the register of
 * `scope` (the conversation's MLS group id). The ONE reader of the frame, so the live handler and the
 * archive replay cannot hold it to two rules.
 *
 * - **The setter is `senderNorm`**, the identity MLS authenticated for the frame - never a payload
 *   field, which any member could fill with somebody else's name.
 * - **Anybody may name anybody** (owner, 2026-10-14: a group has no ranks), so there is no
 *   permission to check; the frame is held to the nickname's own limits instead
 *   (`normalizeNickname`), since no server refuses a malformed one for us. A refusal ACCUSES: a build
 *   of this app never sends one, so reaching it means a peer that is not one.
 * - `at` is the sender's clock; a frame without one is dated `fallbackAt` (the log entry's time on a
 *   replay, the receipt on a live frame). It is BOUNDED by `serverAt` - the server's time for the
 *   frame (its queue time live, its log row's time on a replay) - plus a small skew
 *   (`boundedNicknameAt`): an unbounded date would let one frame dated next year freeze a nickname
 *   against every later change.
 */
export function applyNicknameFrame(
  scope: string,
  data: { userId?: unknown; nickname?: unknown; at?: unknown } | null | undefined,
  senderNorm: string,
  fallbackAt: number,
  log: (msg: string) => void,
  serverAt?: number
): NicknameFrameOutcome {
  const userId = typeof data?.userId === 'string' ? data.userId.trim().toLowerCase() : '';
  const normalized = normalizeNickname(typeof data?.nickname === 'string' ? data.nickname : null);
  if (!userId || !normalized.ok) {
    log(
      `[NICKNAME] REFUSED a nickname frame from ${senderNorm.slice(0, 8)} in ${scope.slice(0, 8)}…: ${userId ? normalized.ok || normalized.code : 'it names nobody'}`
    );
    return 'refused';
  }
  const at = boundedNicknameAt(Number(data?.at) || fallbackAt, serverAt);
  const applied = applyNickname(scope, userId, {
    nickname: normalized.value,
    setBy: senderNorm,
    at,
  });
  if (applied) {
    log(
      `[NICKNAME] ${userId.slice(0, 8)} ${normalized.value === null ? 'reset' : 'renamed'} by ${senderNorm.slice(0, 8)} in ${scope.slice(0, 8)}…`
    );
  }
  return applied ? 'applied' : 'stale';
}
