/**
 * THE reconnect ladder of this app's sockets: 1 s, doubling, capped at 30 s.
 *
 * Shared by the chat gateway's reconnect loop (`useChatSession`, which never stops: only a proof
 * may end it) and the call signalling resume (`CallService`, which stops on an ATTEMPT COUNT, its
 * own budget). One ladder, so a network blip is retried at the same moments by both sockets.
 */
export const RECONNECT_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * The wait before the reconnect attempt at `index` (0 = the first attempt after a loss). Past the
 * end of the ladder the last rung repeats: it is a steady state, not a last attempt.
 */
export function reconnectDelayMs(index: number): number {
  const i = Math.min(Math.max(0, index), RECONNECT_DELAYS_MS.length - 1);
  return RECONNECT_DELAYS_MS[i];
}
