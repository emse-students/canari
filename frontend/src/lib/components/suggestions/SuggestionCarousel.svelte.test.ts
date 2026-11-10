// @vitest-environment happy-dom
/**
 * THE SUGGESTION ROW (engagement WP-6): a card per suggestion with "N en commun" and its faces and
 * no reason line (L11), the X that dismisses for good (and comes back on a refusal), a request that
 * keeps its card showing "Demande envoyee", and a row that disappears once every card is followed
 * or dismissed. "Suivez aussi..." reads the READER's suggestions minus the account just followed.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

const api = vi.hoisted(() => ({
  askToFollow: vi.fn(),
  leaveFollow: vi.fn(),
  withdrawFollowRequest: vi.fn(),
  getFollowStatuses: vi.fn(),
  getFollowSuggestions: vi.fn(),
  dismissFollowSuggestion: vi.fn(),
}));
vi.mock('$lib/follows/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...api,
}));
const asso = vi.hoisted(() => ({
  followAssociation: vi.fn(),
  getAssociationFollowStatus: vi.fn(),
  unfollowAssociation: vi.fn(),
  listMyFollowedAssociations: vi.fn(),
  ensureMyAssociations: vi.fn(),
  didMyAssociationsProbeFail: vi.fn(() => false),
}));
vi.mock('$lib/associations/api', () => asso);
vi.mock('$app/navigation', () => ({ beforeNavigate: () => {} }));
vi.mock('$lib/users/blocks', () => ({
  listBlockedUsers: vi.fn(async () => []),
  onBlocksChanged: () => () => {},
}));
vi.mock('$lib/stores/connectivity.svelte', () => ({
  connectivity: { onReconnect: () => () => {} },
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => toast);
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'me' }));
vi.mock('$lib/utils/users/displayName', () => ({
  peekUserDisplayName: (id: string) => `Name ${id}`,
  resolveUserDisplayName: async (id: string) => `Name ${id}`,
}));
const faces = vi.hoisted(() => ({ avatars: [] as string[] }));
vi.mock('$lib/components/shared/Avatar.svelte', () => ({
  default: (_anchor: unknown, props: { userId: string }) => {
    faces.avatars.push(props.userId);
  },
}));
vi.mock('$lib/components/shared/AssociationAvatar.svelte', () => ({ default: () => {} }));

import SuggestionCarousel from './SuggestionCarousel.svelte';
import FollowAlsoSuggestions from './FollowAlsoSuggestions.svelte';
import { interleaveCards } from '$lib/follows/suggestions.svelte';
import { forgetReaderCaches } from '$lib/utils/sharedCache';
import { FOLLOW_BLOCKED } from '$lib/follows/api';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { m } from '$lib/paraglide/messages';

const ENTITY = '5e000000-0000-4000-8000-000000000001';
const DATA = {
  people: [
    { userId: 'ann', mutual: 4, faces: ['f1', 'f2', 'f3'] },
    { userId: 'bob', mutual: 0, faces: [] },
  ],
  entities: [{ id: ENTITY, name: 'BDE', slug: 'bde', logoUrl: null, type: 'association' }],
};

let component: ReturnType<typeof mount> | null = null;

async function settle() {
  for (let i = 0; i < 10; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

function renderRow() {
  component = mount(SuggestionCarousel, {
    target: document.body,
    props: { cards: interleaveCards(DATA), title: 'T', surface: 'inline' },
  });
}

const cardIds = () =>
  [...document.querySelectorAll('[data-suggestion-card]')].map((el) =>
    el.getAttribute('data-suggestion-id')
  );

beforeEach(() => {
  // Reduced motion: the carousel then plays no transition, so a leaving card is gone at once (the
  // outro is a visual, and happy-dom cannot play one).
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  forgetReaderCaches();
  vi.clearAllMocks();
  faces.avatars.length = 0;
  api.getFollowStatuses.mockResolvedValue({});
  asso.listMyFollowedAssociations.mockResolvedValue([]);
  asso.ensureMyAssociations.mockResolvedValue([]);
  api.dismissFollowSuggestion.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('SuggestionCarousel', () => {
  it('draws a card per suggestion, "N en commun" with its faces, and no reason line', async () => {
    renderRow();
    await settle();
    expect(cardIds()).toEqual(['ann', ENTITY, 'bob']);
    const ann = document.querySelector('[data-suggestion-id="ann"]')!;
    expect(ann.querySelector('[data-suggestion-common]')?.textContent).toContain(
      m.suggestions_common_count({ count: 4 })
    );
    // bob has no shared link: no count at all, never "0 en commun".
    const bob = document.querySelector('[data-suggestion-id="bob"]')!;
    expect(bob.querySelector('[data-suggestion-common]')).toBeNull();
    expect(bob.textContent?.trim()).not.toMatch(/promo|membre/i);
    expect(document.querySelectorAll('[data-follow-chip]')).toHaveLength(3);
    // ann's photo and her three faces, bob's photo: no face for a card with no shared link.
    expect(faces.avatars).toEqual(['ann', 'f1', 'f2', 'f3', 'bob']);
  });

  it('the first card snaps to the inset, not the scroller edge (scroll padding matches px-4)', async () => {
    renderRow();
    await settle();
    // snap-start aligns to the snapport, which ignores padding: without scroll-padding the first
    // card lands flush against the left edge once the row is swiped back.
    const row = document.querySelector('[data-suggestion-id="ann"]')!.closest('ul')!;
    expect(row.classList).toContain('px-4');
    expect(row.classList).toContain('scroll-px-4');
  });

  it('the X dismisses for good: the card leaves at once and the server is told', async () => {
    renderRow();
    await settle();
    (
      document.querySelector('[data-suggestion-id="bob"] [data-suggestion-dismiss]') as HTMLElement
    ).click();
    await settle();
    expect(api.dismissFollowSuggestion).toHaveBeenCalledWith('user', 'bob');
    expect(cardIds()).toEqual(['ann', ENTITY]);
  });

  it('a refused dismissal brings the card back with a toast', async () => {
    api.dismissFollowSuggestion.mockRejectedValue(new Error('500'));
    renderRow();
    await settle();
    (
      document.querySelector(
        `[data-suggestion-id="${ENTITY}"] [data-suggestion-dismiss]`
      ) as HTMLElement
    ).click();
    await settle();
    expect(cardIds()).toEqual(['ann', ENTITY, 'bob']);
    expect(toast.showToast).toHaveBeenCalledWith(m.suggestions_dismiss_failed(), 'error');
  });

  it('a card stays drawn while the follow is out, and a refusal brings the button back without the card ever leaving', async () => {
    let refuse!: (e: unknown) => void;
    api.askToFollow.mockReturnValue(new Promise((_, rej) => (refuse = rej)));
    renderRow();
    await settle();
    (
      document.querySelector('[data-suggestion-id="ann"] [data-follow-chip]') as HTMLElement
    ).click();
    await settle();
    // Out, not answered: the optimistic flip hid the button but the card is still there, in place.
    expect(cardIds()).toEqual(['ann', ENTITY, 'bob']);
    expect(document.querySelector('[data-suggestion-id="ann"] [data-follow-chip]')).toBeNull();
    refuse(new ApiRefusalError(403, FOLLOW_BLOCKED, 'x'));
    await settle();
    expect(cardIds()).toEqual(['ann', ENTITY, 'bob']);
    expect(document.querySelector('[data-suggestion-id="ann"] [data-follow-chip]')).not.toBeNull();
    expect(toast.showToast).toHaveBeenCalledTimes(1);
    expect(toast.showToast).toHaveBeenCalledWith(m.refusal_follow_blocked());
  });

  it('a follow removes its card, soft button and all; a followed entity leaves too; then the row hides', async () => {
    api.askToFollow.mockResolvedValue('pending');
    asso.followAssociation.mockResolvedValue(undefined);
    renderRow();
    await settle();
    const soft = document.querySelector('[data-suggestion-id="ann"] [data-follow-chip]')!;
    expect(soft.getAttribute('data-follow-chip-variant')).toBe('soft');
    (soft as HTMLElement).click();
    await settle();
    expect(cardIds()).toEqual([ENTITY, 'bob']);
    expect(toast.showToast).toHaveBeenCalledWith(
      m.follow_toast_requested_named({ name: 'Name ann' }),
      'info'
    );
    (
      document.querySelector(`[data-suggestion-id="${ENTITY}"] [data-follow-chip]`) as HTMLElement
    ).click();
    await settle();
    expect(cardIds()).toEqual(['bob']);
    expect(toast.showToast).toHaveBeenCalledWith(
      m.follow_toast_following_named({ name: 'BDE' }),
      'info'
    );
    // The last open card dismissed: nothing is left to act on, so the whole row goes.
    (
      document.querySelector('[data-suggestion-id="bob"] [data-suggestion-dismiss]') as HTMLElement
    ).click();
    await settle();
    expect(document.querySelector('[data-suggestions]')).toBeNull();
  });
});

describe('FollowAlsoSuggestions', () => {
  it("reads the reader's own suggestions minus the account just followed, people only, five at most", async () => {
    api.getFollowSuggestions.mockResolvedValue({ ...DATA, followingCount: 9 });
    component = mount(FollowAlsoSuggestions, {
      target: document.body,
      props: { exclude: 'zed' },
    });
    await settle();
    expect(api.getFollowSuggestions).toHaveBeenCalledWith({ limit: 5, exclude: 'zed' });
    expect(document.querySelector('[data-suggestions="also"]')).not.toBeNull();
    expect(cardIds()).toEqual(['ann', 'bob']);
  });

  it('draws nothing when the read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.getFollowSuggestions.mockRejectedValue(new Error('offline'));
    component = mount(FollowAlsoSuggestions, { target: document.body, props: { exclude: 'zed' } });
    await settle();
    expect(document.querySelector('[data-suggestions]')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
