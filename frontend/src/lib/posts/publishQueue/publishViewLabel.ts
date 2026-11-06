import { m } from '$lib/paraglide/messages';
import type { PublishView } from './publishQueue';

/**
 * The one line the progress banner shows for a queued post, in the member's language. A post with no
 * media goes straight to `publishing`; the media numbers are 1-based for the reader.
 */
export function publishViewLabel(view: PublishView): string {
  const current = Math.min(view.index + 1, Math.max(view.count, 1));
  const count = view.count;
  const percent = Math.round(view.step * 100);
  switch (view.phase) {
    case 'failed':
      return m.publish_queue_failed({ reason: view.failure ?? m.post_create_publish_error() });
    case 'waiting':
      return m.publish_queue_waiting();
    case 'paused':
      return m.publish_queue_paused();
    case 'withdrawing':
      return m.publish_queue_withdrawing();
    case 'preparing':
      return percent > 0
        ? m.publish_queue_preparing_percent({ current, count, percent })
        : m.publish_queue_preparing({ current, count });
    case 'uploading':
      return m.publish_queue_uploading({ current, count, percent });
    case 'publishing':
      return m.publish_queue_publishing();
    default:
      return m.publish_queue_queued();
  }
}
