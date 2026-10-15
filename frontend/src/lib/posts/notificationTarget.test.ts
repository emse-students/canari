/**
 * A DESTINATION THAT DIFFERS BETWEEN TWO SURFACES IS A BUG NEITHER OF THEM CAN SEE.
 *
 * The bell dropdown and `/notifications` each carried their own copy of this ternary. These pin the
 * one answer, and in particular the two that are easy to get backwards: a calendar manager goes to
 * the queue where they can ACT, and a proposer goes to the agenda where the answer is already
 * applied. Sending either to the other's page is a reader looking at a screen with nothing to do.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  KNOWN_NOTIFICATION_TYPES,
  isKnownNotificationType,
  notificationHref,
  resolveNotificationHref,
} from './notificationTarget';

describe('notificationHref', () => {
  it('gives an unknown type NO link, never /posts/<id>', () => {
    expect(notificationHref({ type: 'booking_full', postId: 'x1' })).toBeNull();
    expect(isKnownNotificationType('booking_full')).toBe(false);
    expect(isKnownNotificationType('comment')).toBe(true);
  });

  it('sends a post notification to its post', () => {
    expect(notificationHref({ type: 'comment', postId: 'p1' })).toBe('/posts/p1');
    expect(notificationHref({ type: 'reaction', postId: 'p1' })).toBe('/posts/p1');
    expect(notificationHref({ type: 'mention', postId: 'p1' })).toBe('/posts/p1');
  });

  it('sends a form reminder to its form', () => {
    expect(notificationHref({ type: 'form_reminder', postId: 'f1' })).toBe('/forms/f1');
  });

  it('sends a calendar manager to the queue, where the event can actually be validated', () => {
    // `postId` is the ASSOCIATION here, not an event, and a pending event has no page of its own.
    expect(notificationHref({ type: 'event_proposed', postId: 'assoc-1' })).toBe('/admin/agenda');
  });

  it('sends the proposer to the agenda, where the answer is already applied', () => {
    for (const type of ['event_validated', 'event_rejected', 'event_updated', 'event_deleted']) {
      expect(notificationHref({ type, postId: 'assoc-1' }), type).toBe('/calendar');
    }
  });

  it('sends the answer to a profile correction request to the profile, never to a post of that id', () => {
    // `postId` is the REQUEST's id, which has no page: `/posts/<request id>` would be a 404.
    for (const type of ['profile_correction_applied', 'profile_correction_refused']) {
      expect(notificationHref({ type, postId: 'req-1' }), type).toBe('/profile');
    }
  });

  it('gives every known type a destination, bar the two resolved by slug', () => {
    // Compared with a hand-written count so a type removed from the set cannot pass silently.
    expect(KNOWN_NOTIFICATION_TYPES.size).toBe(18);
    for (const type of KNOWN_NOTIFICATION_TYPES) {
      const slugged = type === 'repost_proposed' || type === 'coorganise_proposed';
      expect(notificationHref({ type, postId: 'x1' }) === null, type).toBe(slugged);
    }
  });

  it('gives a type it has never heard of NO link, so the row can say so instead of a dead /posts/<id>', () => {
    expect(notificationHref({ type: 'something_new', postId: 'x' })).toBeNull();
  });
});

describe('resolveNotificationHref', () => {
  it('sends a republication proposal to the receiving association queue, by slug', async () => {
    // `postId` is the RECEIVING association's id (D38); its page is reached by slug.
    const lookup = vi.fn(async (id: string) => (id === 'assoc-1' ? 'bde' : 'other'));
    await expect(
      resolveNotificationHref({ type: 'repost_proposed', postId: 'assoc-1' }, lookup)
    ).resolves.toBe('/associations/bde/edit/republications');
  });

  it('sends a co-organisation proposal to the same queue (D39)', async () => {
    const lookup = vi.fn(async () => 'club');
    await expect(
      resolveNotificationHref({ type: 'coorganise_proposed', postId: 'assoc-2' }, lookup)
    ).resolves.toBe('/associations/club/edit/republications');
    expect(lookup).toHaveBeenCalledWith('assoc-2');
  });

  it('sends a republication to the post, with no lookup', async () => {
    const lookup = vi.fn(async () => 'never');
    await expect(
      resolveNotificationHref({ type: 'association_repost', postId: 'p1' }, lookup)
    ).resolves.toBe('/posts/p1');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects when the association cannot be found, rather than guessing a page', async () => {
    const lookup = vi.fn(async () => {
      throw new Error('404');
    });
    await expect(
      resolveNotificationHref({ type: 'repost_proposed', postId: 'gone' }, lookup)
    ).rejects.toThrow('404');
  });
});
