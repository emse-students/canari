import { socialDeepLink } from './push-target';

describe('socialDeepLink - the payload contract of a tap', () => {
  it('a post notice opens the post', () => {
    expect(socialDeepLink({ type: 'social', postId: 'p1' })).toBe('fr.emse.canari://post/p1');
  });

  it('a comment, reply or mention in a comment opens the post at that comment', () => {
    expect(socialDeepLink({ type: 'social', postId: 'p1', commentId: 'c1' })).toBe(
      'fr.emse.canari://post/p1?comment=c1'
    );
    // The comment id is encoded like the post id: it cannot add a parameter.
    expect(socialDeepLink({ postId: 'p1', commentId: 'c1&x=1' })).toBe(
      'fr.emse.canari://post/p1?comment=c1%26x%3D1'
    );
  });

  it('a form reminder opens the form', () => {
    expect(socialDeepLink({ type: 'form_reminder', formId: 'f1' })).toBe(
      'fr.emse.canari://form/f1'
    );
  });

  it("the organiser alert opens that form's RESPONSES, not the page that answers it", () => {
    expect(socialDeepLink({ type: 'social', target: 'form-responses', formId: 'f1' })).toBe(
      'fr.emse.canari://form-responses/f1'
    );
    expect(socialDeepLink({ target: 'form-responses', formId: 'a/b?x=1' })).toBe(
      'fr.emse.canari://form-responses/a%2Fb%3Fx%3D1'
    );
    // The target without a form names nothing to open: the plain fallback, never an empty id.
    expect(socialDeepLink({ type: 'social', target: 'form-responses' })).toBe(
      'fr.emse.canari://posts'
    );
  });

  it('an event proposal opens the validation queue, the other agenda notices the calendar', () => {
    const base = { type: 'social', associationId: 'a1' };
    expect(socialDeepLink({ ...base, action: 'proposed' })).toBe('fr.emse.canari://admin-agenda');
    for (const action of ['validated', 'rejected', 'updated', 'deleted', 'pending']) {
      expect(socialDeepLink({ ...base, action })).toBe('fr.emse.canari://calendar');
    }
  });

  it('a repost or co-organisation proposal opens the queue of the receiving association, not the feed', () => {
    expect(socialDeepLink({ type: 'social', queueAssociationId: 'a1' })).toBe(
      'fr.emse.canari://proposals/a1'
    );
  });

  it('a live notice opens the live, its id encoded like any other', () => {
    expect(socialDeepLink({ type: 'social', liveId: 'l1' })).toBe('fr.emse.canari://live/l1');
    expect(socialDeepLink({ liveId: 'a/b?x=1' })).toBe('fr.emse.canari://live/a%2Fb%3Fx%3D1');
  });

  it("a republication request opens the author's requests page, never a path the payload names", () => {
    expect(socialDeepLink({ type: 'social', target: 'republication-requests' })).toBe(
      'fr.emse.canari://republication-requests'
    );
    // Only the closed value is a target: anything else is ignored, never concatenated.
    expect(socialDeepLink({ type: 'social', target: 'chat/x' })).toBe('fr.emse.canari://posts');
  });

  it('a follow request opens the request inbox, even though it carries the asker as postId', () => {
    expect(socialDeepLink({ type: 'social', postId: 'asker-1', target: 'follow-requests' })).toBe(
      'fr.emse.canari://follow-requests'
    );
  });

  it('a notice with no page of its own opens the notifications list, even when it carries a postId', () => {
    // A cut live's notice carries the live's id as `postId`: a post link would open nothing.
    expect(socialDeepLink({ type: 'social', postId: 'live-1', target: 'notifications' })).toBe(
      'fr.emse.canari://notifications'
    );
  });

  it("a booking's notice opens Reservations, even though it carries the booking as postId", () => {
    expect(socialDeepLink({ type: 'social', postId: 'booking-1', target: 'bookings' })).toBe(
      'fr.emse.canari://bookings'
    );
  });

  it('a payload naming nothing opens the posts list', () => {
    expect(socialDeepLink({ type: 'social' })).toBe('fr.emse.canari://posts');
  });

  it('never lets an id carry a path or a query', () => {
    expect(socialDeepLink({ postId: 'a/../b?x=1' })).toBe(
      'fr.emse.canari://post/a%2F..%2Fb%3Fx%3D1'
    );
  });
});
