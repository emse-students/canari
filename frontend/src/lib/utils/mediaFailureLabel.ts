import { m } from '$lib/paraglide/messages';
import type { MediaFailureCause } from './mediaErrors';

/**
 * What to tell the reader about a media that could not be shown - one sentence per cause.
 *
 * WHY THE CALLER STILL NAMES TWO OF THEM: a purge and an unclassified failure were already worded
 * per surface and per kind ("Video expiree", "Erreur de chargement audio"), and those words are
 * right where they are. The three causes nobody could tell apart before - no network, gone (404),
 * damaged - read the same on every surface, so they are written once here.
 *
 * @param cause   From `mediaFailureCause`, the one classifier.
 * @param labels  The surface's own wording for `expired` and for `other`.
 */
export function mediaFailureLabel(
  cause: MediaFailureCause,
  labels: { expired: string; other: string }
): string {
  switch (cause) {
    case 'unreachable':
      return m.media_error_unreachable();
    case 'not-found':
      return m.media_error_not_found();
    case 'corrupt':
      return m.media_error_corrupt();
    case 'expired':
      return labels.expired;
    case 'other':
      return labels.other;
  }
}
