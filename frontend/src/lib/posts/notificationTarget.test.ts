/**
 * A DESTINATION THAT DIFFERS BETWEEN TWO SURFACES IS A BUG NEITHER OF THEM CAN SEE.
 *
 * The bell dropdown and `/notifications` each carried their own copy of this ternary. These pin the
 * one answer, and in particular the two that are easy to get backwards: a calendar manager goes to
 * the queue where they can ACT, and a proposer goes to the agenda where the answer is already
 * applied. Sending either to the other's page is a reader looking at a screen with nothing to do.
 */
import { describe, it, expect } from 'vitest';
import { notificationHref } from './notificationTarget';

describe('notificationHref', () => {
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

  it('falls back to the post route for a type it has never heard of', () => {
    // Deliberately not an error: a server that ships a new type before a client knows it must not
    // produce a row that does nothing when tapped.
    expect(notificationHref({ type: 'something_new', postId: 'x' })).toBe('/posts/x');
  });
});
