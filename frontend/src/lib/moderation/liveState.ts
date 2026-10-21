import { m } from '$lib/paraglide/messages';
import type { ReportedLiveState } from './api';

/**
 * The label of each state of a reported live - the ONE map the queue's card and its resolved row
 * share. Called, not a constant: Paraglide labels must be read in the caller's reactive scope to
 * follow a locale change.
 */
export function liveStateLabels(): Record<ReportedLiveState, string> {
  return {
    open: m.moderation_live_state_open(),
    ended: m.moderation_live_state_ended(),
    cut: m.moderation_live_state_cut(),
    gone: m.moderation_live_state_gone(),
  };
}
