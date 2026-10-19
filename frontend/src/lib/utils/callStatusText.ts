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
