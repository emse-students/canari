// @vitest-environment happy-dom
/**
 * A RE-FOLLOW THAT RESETS THE BELL REACHES THE OPEN PICKER (iPhone 12 and Mi 9T, 2026-11-15): the
 * follow answer carries `bellReset`, and the page hands the bell its default level at once. A
 * follow that reset nothing (a retried one) leaves the level the member chose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const state = vi.hoisted(() => ({ uid: null as string | null }));
const getBellLevel = vi.hoisted(() => vi.fn());
const follow = vi.hoisted(() => ({ answer: vi.fn() }));

vi.mock('$lib/follows/bell', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getBellLevel,
}));
vi.mock('$lib/stores/user', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  currentUserId: () => state.uid,
  isGlobalAdmin: () => false,
}));
vi.mock('$lib/associations/api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getAssociationBySlug: vi.fn(async () => ({ id: 'a1', name: 'Asso', type: 'association' })),
  getMyBdeReach: vi.fn(async () => ({ manageAsso: [], validateEvents: [] })),
  listMembers: vi.fn(async () => []),
  listAssociationProducts: vi.fn(async () => []),
  listAssociationPartnerships: vi.fn(async () => []),
}));
vi.mock('$lib/follows/followState.svelte', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readAssociationFollowed: vi.fn(async () => false),
  followAssociationLedgered: follow.answer,
}));
vi.mock('$lib/components/suggestions/FollowAlsoSuggestions.svelte', () => ({ default: () => {} }));
vi.mock('$app/state', () => ({
  page: { url: new URL('https://x.test/associations/a'), params: {} },
}));
vi.mock('$app/env', () => ({ browser: true, dev: false }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));

import AssociationDetailView from './AssociationDetailView.svelte';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;
async function settle() {
  for (let i = 0; i < 10; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

const bell = () => document.querySelector<HTMLElement>('[data-testid="account-bell"]')!;
const followButton = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.includes(m.asso_follow_button())
  )!;

async function openWithBellOn(level: 'none' | 'lives') {
  state.uid = 'u1';
  getBellLevel.mockResolvedValue(level);
  component = mount(AssociationDetailView, {
    target: document.body,
    props: { slug: 'a', kind: 'association' },
  });
  await settle();
  expect(bell().dataset.level).toBe(level);
}

beforeEach(() => {
  getBellLevel.mockReset();
  follow.answer.mockReset();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('AssociationDetailView, the bell after a follow', () => {
  it('shows the default level once the follow answer says the bell was reset', async () => {
    follow.answer.mockResolvedValue({ ok: true, bellReset: true });
    await openWithBellOn('none');
    followButton().click();
    await settle();
    expect(follow.answer).toHaveBeenCalledWith('a1');
    expect(bell().dataset.level).toBe('all');
    expect(getBellLevel).toHaveBeenCalledTimes(1);
  });

  it('keeps the level the member chose when the follow reset nothing', async () => {
    follow.answer.mockResolvedValue({ ok: true, bellReset: false });
    await openWithBellOn('lives');
    followButton().click();
    await settle();
    expect(follow.answer).toHaveBeenCalledWith('a1');
    expect(bell().dataset.level).toBe('lives');
  });
});
