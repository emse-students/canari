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
 * Why a voice is not getting through when an OPERATING SYSTEM is the reason, or `null`. This
 * device's own suspension wins: the user can do something about it (bring the app back), and it is
 * the one they cannot see happening, since the screen is hidden while it lasts. The partner's is
 * what it TOLD us (`MicSuspended`), never a guess from silence. Shared by the full screen and the
 * banner, like {@link callStatusText}.
 */
export function callMicNotice(
  localSuspended: boolean,
  peerSuspended: boolean,
  peerName: string | undefined
): string | null {
  if (localSuspended) return m.call_mic_suspended_local();
  if (peerSuspended) {
    return peerName
      ? m.call_mic_suspended_peer({ name: peerName })
      : m.call_mic_suspended_peer_unnamed();
  }
  return null;
}
