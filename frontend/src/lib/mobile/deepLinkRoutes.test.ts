import { describe, expect, it } from 'vitest';
import { appRouteForDeepLink } from './deepLinkRoutes';

const route = (url: string) => appRouteForDeepLink(new URL(url));

describe('appRouteForDeepLink', () => {
  it('routes every page host a social push can name', () => {
    expect(route('fr.emse.canari://post/p1')).toBe('/posts/p1');
    expect(route('fr.emse.canari://form/f1')).toBe('/forms/f1');
    expect(route('fr.emse.canari://posts')).toBe('/posts');
    expect(route('fr.emse.canari://calendar')).toBe('/calendar');
    expect(route('fr.emse.canari://admin-agenda')).toBe('/admin/agenda');
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
  });

  it('refuses a page host with no id, and hosts it does not own', () => {
    expect(route('fr.emse.canari://post')).toBeNull();
    expect(route('fr.emse.canari://form/')).toBeNull();
    expect(route('fr.emse.canari://chat/g1')).toBeNull();
    expect(route('fr.emse.canari://callback?code=1&state=2')).toBeNull();
    expect(route('https://canari.emse.fr/posts/p1')).toBeNull();
  });

  it('keeps an id inside one path segment', () => {
    expect(route('fr.emse.canari://post/a%2F..%2Fb')).toBe('/posts/a%2F..%2Fb');
  });
});
