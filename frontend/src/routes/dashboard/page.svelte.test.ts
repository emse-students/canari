// @vitest-environment happy-dom
/**
 * THE DASHBOARD HUB, PER READER. Pinned: a member sees identity, Explorer and Compte; a manager
 * adds "Mes associations" (live memberships holding a right, lists under `/lists`); staff add the
 * admin group and the directory; the notification row carries the store's unread count; signing
 * out is the last row of Compte, a button in the danger tone. Every row but that one is a link.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const state = vi.hoisted(() => ({
  mayOpenAdmin: false,
  globalAdmin: false,
  reviewer: false,
  unread: 0,
  memberships: [] as unknown[],
  /** When set, the membership probe waits for `release()`: a cold cache on a slow link. */
  hold: null as null | Promise<void>,
  /** The reviewer probe rejects. */
  reviewerFails: false,
  /** The admin probe never answers (a refresh with no deadline on a dead link). */
  adminHangs: false,
}));
const signOutByChoice = vi.hoisted(() => vi.fn());
const loadNotifs = vi.hoisted(() => vi.fn());

vi.mock('$lib/stores/auth', () => ({ signOutByChoice }));
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'u-1',
  getSavedDisplayName: () => 'Ada Lovelace',
  isGlobalAdmin: () => state.globalAdmin,
}));
vi.mock('$lib/stores/postNotifStore.svelte', () => ({
  postNotifStore: {
    get unread() {
      return state.unread;
    },
    load: loadNotifs,
  },
}));
vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  ensureMyAssociations: async () => {
    if (state.hold) await state.hold;
    return state.memberships;
  },
  getReviewerAccess: () =>
    state.reviewerFails ? Promise.reject(new Error('503')) : Promise.resolve(state.reviewer),
}));
// The identity row's avatar resolves a name and a picture; neither is what is under test here.
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: () => 'Ada Lovelace',
  resolveUserDisplayName: () => Promise.resolve('Ada Lovelace'),
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: () => new Promise(() => {}),
  releaseUserAvatarDisplayUrl: () => {},
}));
vi.mock('$lib/admin/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/admin/access')>()),
  ensureMayOpenAdmin: () =>
    state.adminHangs ? new Promise<boolean>(() => {}) : Promise.resolve(state.mayOpenAdmin),
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];

function asso(over: Record<string, unknown>) {
  return {
    id: 'a',
    name: 'Club',
    slug: 'club',
    type: 'association',
    isAdmin: false,
    archived: false,
    ...over,
  };
}

beforeEach(() => {
  Object.assign(state, {
    mayOpenAdmin: false,
    globalAdmin: false,
    reviewer: false,
    unread: 0,
    memberships: [],
    hold: null,
    reviewerFails: false,
    adminHangs: false,
  });
  signOutByChoice.mockReset().mockResolvedValue(undefined);
  loadNotifs.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function render() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  flushSync();
  for (let i = 0; i < 5; i++) {
    await tick();
    flushSync();
  }
}

/** The rows, in page order, as `key -> href` (`null` for an action row). */
function rows(): [string, string | null][] {
  return [...document.querySelectorAll<HTMLElement>('[data-hub-row]')].map((el) => [
    el.dataset.hubRow!,
    el.getAttribute('href'),
  ]);
}
const keys = () => rows().map(([k]) => k);
const groupHeadings = () =>
  [...document.querySelectorAll('section h2')].map((h) => h.id.replace('group-', ''));

describe('dashboard hub', () => {
  it('shows a member identity, Explorer and Compte, and nothing of a manager or of staff', async () => {
    state.memberships = [asso({ isAdmin: false })];
    await render();
    expect(groupHeadings()).toEqual(['explore', 'account']);
    expect(keys()).toEqual([
      'profile',
      'calendar',
      'associations',
      'lists',
      'institutions',
      'shop',
      'forms',
      'bookings',
      'notifications',
      'settings',
      'sign-out',
    ]);
    expect(rows().find(([k]) => k === 'profile')?.[1]).toBe('/profile');
    expect(document.body.textContent).toContain('Ada Lovelace');
  });

  it('adds "Mes associations" for a manager: live memberships with a right, lists under /lists', async () => {
    state.memberships = [
      asso({ id: 'c', slug: 'club', isAdmin: true, role: 'Présidente' }),
      asso({ id: 'l', slug: 'ma-liste', type: 'list', isAdmin: true }),
      asso({ id: 'o', slug: 'old', isAdmin: true, archived: true }),
      asso({ id: 'p', slug: 'plain', isAdmin: false }),
    ];
    await render();
    // One group per kind, never mixed: associations, then lists.
    expect(groupHeadings()).toEqual(['explore', 'managed', 'managedLists', 'account']);
    const inGroup = (g: string) =>
      [...document.querySelectorAll(`section[aria-labelledby="group-${g}"] [data-hub-row]`)].map(
        (e) => e.getAttribute('data-hub-row')
      );
    expect(inGroup('managed')).toEqual(['managed-c']);
    expect(inGroup('managedLists')).toEqual(['managed-l']);
    expect(rows().filter(([k]) => k.startsWith('managed-'))).toEqual([
      ['managed-c', '/associations/club/edit'],
      ['managed-l', '/lists/ma-liste/edit'],
    ]);
    expect(document.body.textContent).toContain('Présidente');
    expect(keys()).not.toContain('directory');
  });

  it('adds the admin group and the directory for staff, and Documents for a reviewer', async () => {
    state.mayOpenAdmin = true;
    state.reviewer = true;
    await render();
    // The admin group has no visible heading: its one row already says it.
    expect(groupHeadings()).toEqual(['explore', 'account']);
    expect(rows()).toContainEqual(['admin', '/admin']);
    expect(document.querySelector('section[aria-labelledby="group-admin"]')).toBeNull();
    expect(rows()).toContainEqual(['directory', '/directory']);
    // Documents sits with the probed groups, above Compte: arriving, it never pushes sign-out.
    expect(keys().slice(-4)).toEqual(['admin', 'documents', 'settings', 'sign-out']);
  });

  it('carries the unread notification count from the store, and no pill at zero', async () => {
    state.unread = 3;
    await render();
    const badge = document.querySelector('[data-hub-row="notifications"] [data-hub-badge]');
    expect(badge?.textContent?.trim()).toBe('3');
    // The pill is hidden from assistive technology; a sentence is read in its place.
    expect(badge?.getAttribute('aria-hidden')).toBe('true');
    const said = document.querySelector('[data-hub-row="notifications"] [data-hub-badge-label]');
    expect(said?.classList.contains('sr-only')).toBe(true);
    expect(said?.textContent).toContain('3');
    expect(document.querySelectorAll('[data-hub-badge]')).toHaveLength(1);
  });

  it('asks the notification store to load on mount, so a cold open has a count', async () => {
    await render();
    expect(loadNotifs).toHaveBeenCalledOnce();
  });

  it('draws Compte at once and reserves NO space for the probed groups, so Compte only moves down', async () => {
    let release!: () => void;
    state.hold = new Promise<void>((r) => (release = r));
    state.mayOpenAdmin = true;
    await render();
    expect(keys().slice(-3)).toEqual(['notifications', 'settings', 'sign-out']);
    // While waiting: a screen-reader status only, out of the flow - nothing that could collapse
    // later and pull sign-out up under a finger.
    const pending = document.querySelector('[data-dashboard-pending]');
    expect(pending?.getAttribute('role')).toBe('status');
    expect(pending?.classList.contains('sr-only')).toBe(true);
    expect(pending?.children).toHaveLength(0);

    release();
    for (let i = 0; i < 5; i++) {
      await tick();
      flushSync();
    }
    expect(document.querySelector('[data-dashboard-pending]')).toBeNull();
    expect(keys().slice(-3)).toEqual(['admin', 'settings', 'sign-out']);
    expect(keys()).toContain('directory');
  });

  it('settles on a probe that REJECTS: the status clears and the rest still draws', async () => {
    state.reviewerFails = true;
    state.mayOpenAdmin = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    expect(document.querySelector('[data-dashboard-pending]')).toBeNull();
    expect(keys()).not.toContain('documents');
    expect(keys()).toContain('admin');
    expect(keys().slice(-2)).toEqual(['settings', 'sign-out']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('reviewer access probe failed'),
      expect.any(Error)
    );
  });

  it('keeps sign-out reachable when a probe NEVER answers', async () => {
    state.adminHangs = true;
    await render();
    expect(document.querySelector('[data-dashboard-pending]')).not.toBeNull();
    expect(keys().slice(-2)).toEqual(['settings', 'sign-out']);
    document.querySelector<HTMLElement>('[data-hub-row="sign-out"]')!.click();
    await tick();
    expect(signOutByChoice).toHaveBeenCalledOnce();
  });

  it('draws no pill when nothing is unread', async () => {
    await render();
    expect(document.querySelector('[data-hub-badge]')).toBeNull();
  });

  it('signs out from the last row of Compte, a danger-toned button', async () => {
    await render();
    const row = document.querySelector<HTMLElement>('[data-hub-row="sign-out"]')!;
    expect(row.tagName).toBe('BUTTON');
    expect(row.className).toContain('text-red-err');
    expect(keys().at(-1)).toBe('sign-out');
    row.click();
    await tick();
    expect(signOutByChoice).toHaveBeenCalledOnce();
  });

  it('ignores a second sign-out tap while the first is pending, and marks the row busy', async () => {
    let finish!: () => void;
    signOutByChoice.mockReturnValue(new Promise<void>((r) => (finish = r)));
    await render();
    const row = document.querySelector<HTMLButtonElement>('[data-hub-row="sign-out"]')!;
    row.click();
    await tick();
    expect(row.disabled).toBe(true);
    expect(row.getAttribute('aria-busy')).toBe('true');
    row.click();
    await tick();
    expect(signOutByChoice).toHaveBeenCalledOnce();
    finish();
    await tick();
    await tick();
    expect(row.disabled).toBe(false);
  });

  it('has no theme control any more: the theme lives in settings', async () => {
    await render();
    expect(keys()).not.toContain('theme');
    expect(rows().filter(([, href]) => href === null)).toEqual([['sign-out', null]]);
  });
});
