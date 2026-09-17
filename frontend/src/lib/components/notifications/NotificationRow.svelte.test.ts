/**
 * A NOTIFICATION FOR AN ASSOCIATION'S POST SHOWED THE PUBLISHING MEMBER'S PHOTO, NOT THE
 * ASSOCIATION'S LOGO.
 *
 * `actorId` on an `association_post` notification is deliberately the member who pressed publish
 * (`createNotifications` excludes the actor from its own recipients, and that exclusion needs the
 * member, not the association) - but the row used to render a plain `Avatar` keyed on that id
 * regardless of type, with nothing to tell it the notification actually concerns an association.
 * `associationId`/`associationLogoUrl` (added alongside this fix) give it that signal.
 *
 * `Avatar` and `AssociationAvatar` both render their own fallback branch SYNCHRONOUSLY, before
 * either component's network-resolving effect has a chance to answer - `aria-label` distinguishes
 * them ("Avatar de ..." vs "Logo de ...") without waiting on anything async.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import NotificationRow from './NotificationRow.svelte';
import type { PostNotification } from '$lib/posts/api';

// `Avatar` resolves a display name on mount - stubbed so the test never reaches the network,
// same convention `MessageReactions.test.ts` uses for the same reason.
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));

// `Avatar`/`AssociationAvatar` each resolve an image URL on mount too - the very first test in this
// repo to mount either directly, so there is no existing convention to lean on. Stubbed rather than
// left to hit the network: happy-dom actually attempts the fetch, which then aborts noisily when
// the test environment tears down mid-flight.
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));
vi.mock('$lib/utils/associationLogoCache', () => ({
  resolveAssociationLogoDisplayUrl: async () => null,
  releaseAssociationLogoDisplayUrl: () => {},
}));

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function renderRow(notif: PostNotification) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(NotificationRow, {
    target,
    props: { notif, unread: false, onOpen: () => {} },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

describe('NotificationRow avatar', () => {
  it('renders the association logo for an association post, not the publisher’s photo', () => {
    const notif: PostNotification = {
      id: 'n1',
      type: 'association_post',
      postId: 'p1',
      actorId: 'member-1',
      actorName: 'BDE',
      associationId: 'asso-1',
      associationLogoUrl: '/api/media/public/logo1',
      text: 'Soiree',
      read: false,
      createdAt: new Date().toISOString(),
    };

    const target = renderRow(notif);

    expect(target.querySelector('[aria-label^="Logo de"]')).not.toBeNull();
    expect(target.querySelector('[aria-label^="Avatar de"]')).toBeNull();
  });

  it('still renders a user avatar for a personal notification', () => {
    const notif: PostNotification = {
      id: 'n2',
      type: 'reaction',
      postId: 'p2',
      actorId: 'user-1',
      actorName: 'Claire',
      text: '\u{1F600}',
      read: false,
      createdAt: new Date().toISOString(),
    };

    const target = renderRow(notif);

    expect(target.querySelector('[aria-label^="Avatar de"]')).not.toBeNull();
    expect(target.querySelector('[aria-label^="Logo de"]')).toBeNull();
  });

  it('falls back to a user avatar for an association post missing the new association id (old row)', () => {
    // A row written before this migration has `associationId: null` - the exact case this test
    // guards, since NotificationRow gates on `notif.associationId`, not merely on `notif.type`.
    const notif: PostNotification = {
      id: 'n3',
      type: 'association_post',
      postId: 'p3',
      actorId: 'member-1',
      actorName: 'BDE',
      text: 'Soiree',
      read: false,
      createdAt: new Date().toISOString(),
    };

    const target = renderRow(notif);

    expect(target.querySelector('[aria-label^="Avatar de"]')).not.toBeNull();
    expect(target.querySelector('[aria-label^="Logo de"]')).toBeNull();
  });
});

/**
 * AND THE SENTENCE UNDER THAT AVATAR SAID THE ASSOCIATION HAD COMMENTED.
 *
 * Reported by the user on 2026-09-17, one screenshot: "BDA - Bureau des Arts a commente : [Scene
 * ouverte lundi 28/09]". The chain of `{:else if}` in the row ends in the COMMENT branch, so the
 * two publication types - which it never named - inherited the comment sentence. The push for the
 * same row already said "a publie", so the phone and the page disagreed about one notification.
 *
 * These assert the SENTENCE rather than the branch, because the defect was invisible to a check on
 * the type: the row rendered, the avatar was right after #781, and only the verb was wrong.
 */
describe('NotificationRow sentence', () => {
  const postRow = (type: string): PostNotification => ({
    id: `n-${type}`,
    type,
    postId: 'p9',
    actorId: 'member-1',
    actorName: 'BDA',
    text: 'Scene ouverte lundi',
    read: false,
    createdAt: new Date().toISOString(),
  });

  it('says an association PUBLISHED, never that it commented', () => {
    const text = renderRow(postRow('association_post')).textContent ?? '';
    expect(text).toContain('a publié');
    expect(text).not.toContain('a commenté');
  });

  it('says a followed person PUBLISHED, never that they commented', () => {
    const text = renderRow(postRow('followed_post')).textContent ?? '';
    expect(text).toContain('a publié');
    expect(text).not.toContain('a commenté');
  });

  it('still says commented for an actual comment', () => {
    const text = renderRow(postRow('comment')).textContent ?? '';
    expect(text).toContain('a commenté');
  });
});
