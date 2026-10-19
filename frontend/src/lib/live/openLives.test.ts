/** The card's list: the reader's own live left out, a lost answer kept, a refusal hidden. */
import { describe, it, expect, vi } from 'vitest';
import { formatLiveElapsed, livesForFeed, loadOpenLivesForFeed } from './openLives';
import { LiveRefusalError } from './api';
import { TransportFailureError } from '$lib/utils/transportFailure';
import type { LiveListItem } from './types';

const item = (id: string, broadcasterId: string): LiveListItem => ({
  id,
  broadcasterId,
  associationId: null,
  startedAt: '2026-10-19T10:00:00.000Z',
});

describe('livesForFeed', () => {
  it("keeps the server's order and leaves the reader's own live out", () => {
    const list = [item('a', 'u1'), item('b', 'me'), item('c', 'u2')];
    expect(livesForFeed(list, 'me').map((l) => l.id)).toEqual(['a', 'c']);
    expect(livesForFeed(list, null).map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('loadOpenLivesForFeed', () => {
  it('answers the filtered list', async () => {
    const out = await loadOpenLivesForFeed(
      'me',
      vi.fn(async () => [item('a', 'me'), item('b', 'x')])
    );
    expect(out).toEqual({ kind: 'answered', lives: [item('b', 'x')] });
  });

  it('keeps what the card shows when nobody answered', async () => {
    const out = await loadOpenLivesForFeed(
      'me',
      vi.fn(async () => {
        throw new TransportFailureError('offline');
      })
    );
    expect(out).toEqual({ kind: 'kept' });
  });

  it('hides the card when the switch is off or the list is refused', async () => {
    const disabled = new LiveRefusalError(404, null, 'x', 'disabled', null, null, null);
    const refused = new LiveRefusalError(400, 'X', 'x', 'refused', null, null, null);
    for (const e of [disabled, refused]) {
      const out = await loadOpenLivesForFeed(
        'me',
        vi.fn(async () => {
          throw e;
        })
      );
      expect(out).toEqual({ kind: 'hidden' });
    }
  });
});

describe('formatLiveElapsed', () => {
  it('is m:ss under an hour and h:mm:ss from it', () => {
    expect(formatLiveElapsed(0)).toBe('0:00');
    expect(formatLiveElapsed(65_400)).toBe('1:05');
    expect(formatLiveElapsed(3_600_000 + 2 * 60_000 + 3_000)).toBe('1:02:03');
    expect(formatLiveElapsed(-5)).toBe('0:00');
  });
});
