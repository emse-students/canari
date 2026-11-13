import { describe, expect, it } from 'vitest';
import { barPublishAction, overflowActions, publicationState } from './publishAction';

const facts = (isPublished: boolean, live: string | null, saved: string | null) => ({
  isPublished,
  liveFingerprint: live,
  savedFingerprint: saved,
});

describe('publication decision', () => {
  it('offline: the bar offers Publish, the menu only the export', () => {
    const f = facts(false, null, 'x');
    expect(publicationState(f)).toBe('offline');
    expect(barPublishAction(f)).toBe('publish');
    expect(overflowActions(f)).toEqual(['export']);
  });
  it('live and older than the save: the bar offers the update, the menu does not repeat it', () => {
    const f = facts(true, 'old', 'new');
    expect(publicationState(f)).toBe('stale');
    expect(barPublishAction(f)).toBe('update');
    expect(overflowActions(f)).toEqual(['unpublish', 'export']);
  });
  it('live with no recorded fingerprint is unknown, never current', () => {
    const f = facts(true, null, 'new');
    expect(publicationState(f)).toBe('unknown');
    expect(barPublishAction(f)).toBe('update');
  });
  it('live and current: no bar button, but the menu can still republish', () => {
    const f = facts(true, 'same', 'same');
    expect(publicationState(f)).toBe('current');
    expect(barPublishAction(f)).toBeNull();
    expect(overflowActions(f)).toEqual(['update', 'unpublish', 'export']);
  });
  it('an unknown saved fingerprint is unknown too', () => {
    expect(publicationState(facts(true, 'a', null))).toBe('unknown');
  });
});
