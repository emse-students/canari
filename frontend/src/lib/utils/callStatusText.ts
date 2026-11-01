import { m } from '$lib/paraglide/messages';
import type { CallStatusKind } from '$lib/stores/callView.svelte';

/**
 * The status line of a call surface, for one {@link CallStatusKind}: the running duration while the
 * call is live, a word otherwise. Shared by the full screen and the top banner so the same moment
 * reads the same on both.
 */
export function callStatusText(kind: CallStatusKind, duration: string): string {
  switch (kind) {
    case 'incoming':
      return m.call_incoming_label();
    case 'ringing':
      return m.call_ringing_label();
    case 'connecting':
      return m.call_connecting_label();
    case 'reconnecting':
      return m.call_reconnecting();
    case 'live':
      return duration;
    case 'ended':
      return m.call_ended_with_duration({ duration });
    case 'idle':
      return '';
  }
}

/**
 * Why a voice is not getting through when an OPERATING SYSTEM is the reason, or `null`. Shown, and
 * announced, only while the call is LIVE - the one rule the full screen, the banner and the live
 * region all read from here, so the three can never disagree: while it rings, connects or
 * reconnects, that status is the more urgent fact. This device's own suspension wins: the user can
 * act on it (bring the app back), and it is the one they could not see happening. The partner's is
 * what it TOLD us (`MicSuspended`), never a guess from silence.
 */
export function callMicNotice(
  kind: CallStatusKind,
  localSuspended: boolean,
  peerSuspended: boolean,
  peerName: string | undefined
): string | null {
  if (kind !== 'live') return null;
  if (localSuspended) return m.call_mic_suspended_local();
  if (peerSuspended) {
    return peerName
      ? m.call_mic_suspended_peer({ name: peerName })
      : m.call_mic_suspended_peer_unnamed();
  }
  return null;
}

/** What the encryption line of the full screen shows: nothing, the check running, or the shield. */
export type CallE2eLine = 'none' | 'verifying' | 'proven';

/**
 * The encryption line for one {@link CallStatusKind}. NOTHING while the call rings (`incoming`,
 * `ringing`): no media exists yet, so there is nothing to verify, and the "verifying" label shown
 * through a 6-57 s ring read as the encryption being the wait (owner, Android 1.5.3, 2026-10-31 -
 * `exportSecret` takes 20-60 ms). From `connecting` on the check is real and named; the shield once
 * `CallService.e2eProven` holds. The ended summary keeps a shield that was earned and never starts
 * a check it can no longer finish.
 */
export function callE2eLine(kind: CallStatusKind, proven: boolean): CallE2eLine {
  switch (kind) {
    case 'idle':
    case 'incoming':
    case 'ringing':
      return 'none';
    case 'ended':
      return proven ? 'proven' : 'none';
    case 'connecting':
    case 'reconnecting':
    case 'live':
      return proven ? 'proven' : 'verifying';
  }
}
