import { m } from '$lib/paraglide/messages';
import type { ReplayTimeLeft } from './replayTimeline';

/** The time left of a replay as the reader sees it ("encore 2 j"), from {@link replayTimeLeft}'s answer. */
export function replayTimeLeftText(left: ReplayTimeLeft): string {
  switch (left.unit) {
    case 'day':
      return m.replay_time_left_days({ count: left.count });
    case 'hour':
      return m.replay_time_left_hours({ count: left.count });
    case 'minute':
      return m.replay_time_left_minutes({ count: left.count });
  }
}
