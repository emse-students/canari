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
  FOLLOW_REQUESTS_ROUTE,
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

  it("sends the organiser of a form paid over capacity to that form's RESPONSES", () => {
    expect(notificationHref({ type: 'form_paid_over_capacity', postId: 'f1' })).toBe(
      '/forms?responses=f1'
    );
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
    expect(KNOWN_NOTIFICATION_TYPES.size).toBe(34);
    // The live moderation notices go nowhere: a cut live is deleted when it ends, and a suspension
    // or a withdrawal has no page.
    const liveModeration = ['live_cut', 'live_suspended', 'live_withdrawn'];
    for (const type of KNOWN_NOTIFICATION_TYPES) {
      const noHref =
        type === 'repost_proposed' ||
        type === 'coorganise_proposed' ||
        type === 'lydia_payments_active' ||
        type === 'lydia_payments_paused' ||
        liveModeration.includes(type);
      expect(notificationHref({ type, postId: 'x1' }) === null, type).toBe(noHref);
    }
  });

  it.each(['booking_cancelled', 'booking_withdrawn', 'booking_added', 'booking_reminder'])(
    '%s opens Reservations: its postId is a booking, which has no page (WP-N)',
    (type) => {
      expect(notificationHref({ type, postId: 'booking-1' })).toBe('/bookings');
    }
  );

  it('sends a follow request to the inbox and an acceptance to the person who said yes (WP-F4)', () => {
    // `postId` is the ASKER for the first and the accepter for the second - never a post.
    expect(notificationHref({ type: 'follow_request', postId: 'asker-1' })).toBe(
      FOLLOW_REQUESTS_ROUTE
    );
    expect(notificationHref({ type: 'follow_accepted', postId: 'bob-1' })).toBe('/profile/bob-1');
  });

  it.each(['live_cut', 'live_suspended', 'live_withdrawn'])(
    'knows %s and gives it no link, so the row is told and inert rather than a dead /posts/<id>',
    (type) => {
      expect(isKnownNotificationType(type)).toBe(true);
      expect(notificationHref({ type, postId: 'live-1' })).toBeNull();
    }
  );

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

  it('a refund opens the purchases of the payer, where the payment reads as refunded', () => {
    // `postId` is the ASSOCIATION's id, which that page does not need.
    expect(notificationHref({ type: 'lydia_refund_issued', postId: 'assoc-9' })).toBe(
      '/account/purchases'
    );
  });

  it.each(['lydia_payments_active', 'lydia_payments_paused'])(
    '%s opens the association payments section, by slug',
    async (type) => {
      // `postId` is the ASSOCIATION's id.
      const lookup = vi.fn(async () => 'bde');
      await expect(resolveNotificationHref({ type, postId: 'assoc-9' }, lookup)).resolves.toBe(
        '/associations/bde/edit/payments'
      );
      expect(lookup).toHaveBeenCalledWith('assoc-9');
    }
  );

  it('sends a republication to the post, with no lookup', async () => {
    const lookup = vi.fn(async () => 'never');
    await expect(
      resolveNotificationHref({ type: 'association_repost', postId: 'p1' }, lookup)
    ).resolves.toBe('/posts/p1');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('sends the author of a personal post to their requests, and the proposer to the post (D38b)', () => {
    expect(notificationHref({ type: 'repost_personal_requested', postId: 'p1' })).toBe(
      '/notifications/requests'
    );
    expect(notificationHref({ type: 'repost_personal_accepted', postId: 'p1' })).toBe('/posts/p1');
    expect(notificationHref({ type: 'repost_personal_refused', postId: 'p1' })).toBe('/posts/p1');
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
