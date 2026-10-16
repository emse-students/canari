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
}));
const clearAuth = vi.hoisted(() => vi.fn());
const leaveSignedOut = vi.hoisted(() => vi.fn());

vi.mock('$lib/stores/auth', () => ({ clearAuth, leaveSignedOut }));
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
  },
}));
vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  ensureMyAssociations: () => Promise.resolve(state.memberships),
  getReviewerAccess: () => Promise.resolve(state.reviewer),
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
  ensureMayOpenAdmin: () => Promise.resolve(state.mayOpenAdmin),
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
  });
  clearAuth.mockReset().mockResolvedValue(undefined);
  leaveSignedOut.mockReset().mockResolvedValue(undefined);
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
    expect(groupHeadings()).toEqual(['explore', 'managed', 'account']);
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
    expect(groupHeadings()).toEqual(['explore', 'admin', 'account']);
    expect(rows()).toContainEqual(['admin', '/admin']);
    expect(rows()).toContainEqual(['directory', '/directory']);
    expect(keys().slice(-3)).toEqual(['settings', 'documents', 'sign-out']);
  });

  it('carries the unread notification count from the store, and no pill at zero', async () => {
    state.unread = 3;
    await render();
    const badge = document.querySelector('[data-hub-row="notifications"] [data-hub-badge]');
    expect(badge?.textContent?.trim()).toBe('3');
    expect(badge?.getAttribute('aria-label')).toBeTruthy();
    expect(document.querySelectorAll('[data-hub-badge]')).toHaveLength(1);
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
    await tick();
    expect(clearAuth).toHaveBeenCalledOnce();
    expect(leaveSignedOut).toHaveBeenCalledOnce();
  });

  it('has no theme control any more: the theme lives in settings', async () => {
    await render();
    expect(keys()).not.toContain('theme');
    expect(rows().filter(([, href]) => href === null)).toEqual([['sign-out', null]]);
  });
});
