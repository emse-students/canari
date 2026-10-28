import { describe, expect, it } from 'vitest';
import { appRouteForDeepLink, proposalQueueAssociationId } from './deepLinkRoutes';

const route = (url: string) => appRouteForDeepLink(new URL(url));

describe('appRouteForDeepLink', () => {
  it('owns no route for a host it does not know (the caller sends the tap to the notifications list)', () => {
    expect(route('fr.emse.canari://some-future-host/x1')).toBeNull();
  });

  it('routes every page host a social push can name', () => {
    expect(route('fr.emse.canari://post/p1')).toBe('/posts/p1');
    expect(route('fr.emse.canari://form/f1')).toBe('/forms/f1');
    expect(route('fr.emse.canari://posts')).toBe('/posts');
    expect(route('fr.emse.canari://calendar')).toBe('/calendar');
    expect(route('fr.emse.canari://admin-agenda')).toBe('/admin/agenda');
    // A live opens the feed until WP-L5's viewer page exists.
    expect(route('fr.emse.canari://live/l1')).toBe('/posts');
    // WP-L8b: a cut live, a suspension, a withdrawal - their row on the notifications list.
    expect(route('fr.emse.canari://notifications')).toBe('/notifications');
    // The organiser alert: one form's responses, on the forms list.
    expect(route('fr.emse.canari://form-responses/f1')).toBe('/forms?responses=f1');
  });

  it('keeps the comment a comment push names, and only that parameter', () => {
    expect(route('fr.emse.canari://post/p1?comment=c1')).toBe('/posts/p1?comment=c1');
    expect(route('fr.emse.canari://post/p1?comment=c1%26x%3D1')).toBe(
      '/posts/p1?comment=c1%26x%3D1'
    );
    expect(route('fr.emse.canari://post/p1?other=1')).toBe('/posts/p1');
  });

  it('matches the in-app bell for the same notification', async () => {
    const { notificationHref } = await import('$lib/posts/notificationTarget');
    expect(route('fr.emse.canari://form/f1')).toBe(
      notificationHref({ type: 'form_reminder', postId: 'f1' })
    );
    expect(route('fr.emse.canari://post/p1')).toBe(
      notificationHref({ type: 'comment', postId: 'p1' })
    );
    expect(route('fr.emse.canari://admin-agenda')).toBe(
      notificationHref({ type: 'event_proposed', postId: 'a1' })
    );
    expect(route('fr.emse.canari://calendar')).toBe(
      notificationHref({ type: 'event_validated', postId: 'a1' })
    );
    // WP-F4: a follow request's push and its in-app row land on the same inbox.
    expect(route('fr.emse.canari://follow-requests')).toBe(
      notificationHref({ type: 'follow_request', postId: 'asker-1' })
    );
    // D38b: the push of a request to the author and its in-app row land on the same inbox.
    expect(route('fr.emse.canari://republication-requests')).toBe(
      notificationHref({ type: 'repost_personal_requested', postId: 'p1' })
    );
    expect(route('fr.emse.canari://form-responses/f1')).toBe(
      notificationHref({ type: 'form_paid_over_capacity', postId: 'f1' })
    );
  });

  it('refuses a page host with no id, and hosts it does not own', () => {
    expect(route('fr.emse.canari://post')).toBeNull();
    expect(route('fr.emse.canari://form/')).toBeNull();
    expect(route('fr.emse.canari://form-responses/')).toBeNull();
    expect(route('fr.emse.canari://chat/g1')).toBeNull();
    expect(route('fr.emse.canari://callback?code=1&state=2')).toBeNull();
    expect(route('https://canari.emse.fr/posts/p1')).toBeNull();
  });

  it('keeps an id inside one path segment', () => {
    expect(route('fr.emse.canari://post/a%2F..%2Fb')).toBe('/posts/a%2F..%2Fb');
    expect(route('fr.emse.canari://form-responses/a%2F..%2Fb%3Fx%3D1')).toBe(
      '/forms?responses=a%2F..%2Fb%3Fx%3D1'
    );
  });
});

describe('proposalQueueAssociationId', () => {
  const id = (url: string) => proposalQueueAssociationId(new URL(url));

  it('names the receiving association of a proposal push', () => {
    expect(id('fr.emse.canari://proposals/a1')).toBe('a1');
  });

  it('leaves every other link, and a link with no id, alone', () => {
    expect(id('fr.emse.canari://proposals')).toBeNull();
    expect(id('fr.emse.canari://post/p1')).toBeNull();
    expect(id('https://canari.emse.fr/proposals/a1')).toBeNull();
    // Not a page the generic table owns: its route needs the slug.
    expect(route('fr.emse.canari://proposals/a1')).toBeNull();
  });
});
