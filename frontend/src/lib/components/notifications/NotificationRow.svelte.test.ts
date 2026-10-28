// @vitest-environment happy-dom
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
import { m } from '$lib/paraglide/messages';

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

  // D38: both actors are ASSOCIATIONS, so both rows draw its logo and their own verb.
  it('says an association RELAYED or PROPOSES to relay, with its logo', () => {
    const relayed = renderRow({ ...postRow('association_repost'), associationId: 'asso-1' });
    expect(relayed.textContent).toContain('a relayé');
    expect(relayed.querySelector('[aria-label^="Logo de"]')).not.toBeNull();
    const proposed = renderRow({ ...postRow('repost_proposed'), associationId: 'asso-1' });
    expect(proposed.textContent).toContain('propose de relayer');
    expect(proposed.textContent).not.toContain('a commenté');
  });

  // D39: the organising association asks to co-organise an event, with its logo.
  it('says an association PROPOSES to co-organise, with its logo', () => {
    const row = renderRow({ ...postRow('coorganise_proposed'), associationId: 'asso-1' });
    expect(row.textContent).toContain('propose de co-organiser');
    expect(row.textContent).not.toContain('a commenté');
    expect(row.querySelector('[aria-label^="Logo de"]')).not.toBeNull();
  });

  // D38b: an association ASKS the author (its logo); the author ANSWERS the proposer (a person).
  it('says an association asks to relay YOUR post, and how the author answered', () => {
    const asked = renderRow({
      ...postRow('repost_personal_requested'),
      associationId: 'asso-1',
    });
    expect(asked.textContent).toContain('demande à relayer votre publication');
    expect(asked.querySelector('[aria-label^="Logo de"]')).not.toBeNull();
    const accepted = renderRow({ ...postRow('repost_personal_accepted'), associationId: 'asso-1' });
    expect(accepted.textContent).toContain('a accepté votre demande');
    expect(accepted.querySelector('[aria-label^="Logo de"]')).toBeNull();
    const refused = renderRow(postRow('repost_personal_refused'));
    expect(refused.textContent).toContain('a refusé votre demande');
    expect(refused.textContent).not.toContain('a commenté');
  });

  // WP-F4: a PERSON asks to follow, or said yes; no text, never the comment sentence, no logo.
  it('says a person asks to follow you, and that a person accepted your request', () => {
    const follow = (type: string) => ({ ...postRow(type), postId: 'member-1', text: '' });
    const asked = renderRow(follow('follow_request'));
    expect(asked.textContent).toContain(m.notif_follow_request_text());
    expect(asked.textContent).not.toContain('a commenté');
    expect(asked.querySelector('[aria-label^="Logo de"]')).toBeNull();
    const accepted = renderRow(follow('follow_accepted'));
    expect(accepted.textContent).toContain(m.notif_follow_accepted_text());
    expect(accepted.textContent).not.toContain('a commenté');
  });
});

/**
 * A PAYMENT LANDED ON A FULL FORM, told to its managers. The row stores the form's TITLE and nothing
 * else (no payer, no amount); the sentence is built here, never a comment's, and the row opens.
 */
describe('NotificationRow for a payment over capacity', () => {
  const row: PostNotification = {
    id: 'n-over',
    type: 'form_paid_over_capacity',
    postId: 'f1',
    actorId: 'system',
    actorName: 'Canari',
    text: 'Gala de printemps',
    read: false,
    createdAt: new Date().toISOString(),
  };

  it('says a refund is owed on that form, never that someone commented', () => {
    const target = renderRow(row);
    expect(target.textContent).toContain(m.notif_form_paid_over_capacity_text());
    expect(target.textContent).toContain('Gala de printemps');
    expect(target.textContent).not.toContain(m.notif_comment_text());
    expect(target.querySelector('button')!.disabled).toBe(false);
  });
});

describe('NotificationRow with a type this build does not know', () => {
  const unknown: PostNotification = {
    id: 'n-unk',
    type: 'unit_test_future_type',
    postId: 'x1',
    actorId: 'u1',
    actorName: 'Marie',
    text: 'Une inscription',
    read: false,
    createdAt: new Date().toISOString(),
  };

  it('renders a neutral, inert row - not the comment sentence - and logs the type once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onOpen = vi.fn();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(NotificationRow, {
      target,
      props: { notif: unknown, unread: false, onOpen },
    });
    mounted.push(() => void unmount(app));
    flushSync();
    const second = document.createElement('div');
    document.body.appendChild(second);
    const app2 = mount(NotificationRow, {
      target: second,
      props: { notif: unknown, unread: false, onOpen },
    });
    mounted.push(() => void unmount(app2));
    flushSync();

    expect(target.textContent).toContain(m.notif_unknown_type_text());
    expect(target.textContent).not.toContain(m.notif_comment_text());
    expect(target.textContent).not.toContain('Marie');
    const button = target.querySelector('button')!;
    expect(button.disabled).toBe(true);
    button.click();
    expect(onOpen).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('unit_test_future_type');
  });
});

/** Written out by hand on purpose: walking the production set would pass when a type left it. */
const EVERY_TYPE_THE_SERVER_EMITS = [
  'comment',
  'reply',
  'reaction',
  'mention',
  'form_reminder',
  'form_paid_over_capacity',
  'association_post',
  'followed_post',
  'association_repost',
  'repost_proposed',
  'coorganise_proposed',
  'event_proposed',
  'event_validated',
  'event_rejected',
  'event_updated',
  'event_deleted',
  'event_pending',
  'profile_correction_applied',
  'profile_correction_refused',
];

describe('NotificationRow with every known type', () => {
  it('is never the neutral row, and stays activatable', () => {
    for (const type of EVERY_TYPE_THE_SERVER_EMITS) {
      const target = renderRow({
        id: `n-${type}`,
        type,
        postId: 'x1',
        actorId: 'u1',
        actorName: 'Marie',
        text: 'Titre',
        read: false,
        createdAt: new Date().toISOString(),
      });
      expect(target.textContent, type).not.toContain(m.notif_unknown_type_text());
      expect(target.querySelector('button')!.disabled, type).toBe(false);
    }
  });
});

describe('NotificationRow for a live a moderator cut', () => {
  const base: PostNotification = {
    id: 'n9',
    type: 'live_cut',
    postId: 'live-1',
    // The server writes no actor for it.
    actorId: '',
    actorName: '',
    text: 'harassment',
    read: false,
    createdAt: new Date().toISOString(),
  };

  it('says it in the readers locale with the reason label, and draws no avatar of nobody', () => {
    const target = renderRow(base);
    expect(target.textContent).toContain(m.notif_live_cut_text());
    expect(target.textContent).toContain(m.moderation_reason_harassment());
    expect(target.textContent).not.toContain(m.notif_unknown_type_text());
    expect(target.querySelector('[data-notif-live-cut-avatar]')).not.toBeNull();
    expect(target.querySelector('[aria-label^="Avatar de"]')).toBeNull();
  });

  it('a suspension and a withdrawal read as their own sentences, with the reason', () => {
    for (const [type, text] of [
      ['live_suspended', m.notif_live_suspended_text()],
      ['live_withdrawn', m.notif_live_withdrawn_text()],
    ] as const) {
      const target = renderRow({ ...base, type });
      expect(target.textContent).toContain(text);
      expect(target.textContent).toContain(m.moderation_reason_harassment());
      expect(target.textContent).not.toContain(m.notif_unknown_type_text());
    }
  });

  it('is not activatable: its live is deleted, there is nowhere to go', () => {
    const target = renderRow(base);
    expect(target.querySelector('button')!.disabled).toBe(true);
  });

  it('a reason that is an Object.prototype name is not a label either', () => {
    const target = renderRow({ ...base, text: 'constructor' });
    expect(target.textContent).toContain(m.notif_live_cut_text());
    expect(target.textContent).not.toContain('constructor');
  });

  it('a reason code this build does not know leaves the sentence alone', () => {
    const target = renderRow({ ...base, text: 'something_new' });
    expect(target.textContent).toContain(m.notif_live_cut_text());
    expect(target.textContent).not.toContain('something_new');
  });
});

describe('NotificationRow for the right to broadcast suspended or withdrawn (WP-L8b)', () => {
  it.each([
    ['live_suspended', () => m.notif_live_suspended_text()],
    ['live_withdrawn', () => m.notif_live_withdrawn_text()],
  ])(
    '%s is told in the reader locale with its reason, inert, with no avatar of nobody',
    (type, text) => {
      const target = renderRow({
        id: 'n10',
        type,
        // The member's own id for a withdrawal, the live's for a suspension: neither is a page.
        postId: 'x1',
        actorId: '',
        actorName: '',
        text: 'spam',
        read: false,
        createdAt: new Date().toISOString(),
      });
      expect(target.textContent).toContain(text());
      expect(target.textContent).toContain(m.moderation_reason_spam());
      expect(target.textContent).not.toContain(m.notif_unknown_type_text());
      expect(target.textContent).not.toContain(m.notif_live_cut_text());
      expect(target.querySelector('[data-notif-live-cut-avatar]')).not.toBeNull();
      expect(target.querySelector('button')!.disabled).toBe(true);
    }
  );
});
