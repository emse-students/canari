// @vitest-environment happy-dom
/**
 * THE BELL'S HEAD START IS FOR A SIGNED-IN READER ONLY (weak-network audit, C3, review of #3345).
 * The bell is drawn inside `{#if userId}`, so a guest never mounted it and never asked for its level;
 * starting the read in the page's batch must not make a guest ask.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const state = vi.hoisted(() => ({ uid: null as string | null }));
const getBellLevel = vi.hoisted(() => vi.fn());

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
}));
vi.mock('$app/state', () => ({
  page: { url: new URL('https://x.test/associations/a'), params: {} },
}));
vi.mock('$app/env', () => ({ browser: true, dev: false }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));

import AssociationDetailView from './AssociationDetailView.svelte';

let component: ReturnType<typeof mount> | null = null;
async function settle() {
  for (let i = 0; i < 10; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

beforeEach(() => {
  getBellLevel.mockReset();
  getBellLevel.mockResolvedValue('all');
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('AssociationDetailView, the bell head start', () => {
  it('a guest asks for no bell level', async () => {
    state.uid = null;
    component = mount(AssociationDetailView, {
      target: document.body,
      props: { slug: 'a', kind: 'association' },
    });
    await settle();
    expect(getBellLevel).not.toHaveBeenCalled();
  });

  it('a signed-in reader asks for it once, with the page batch', async () => {
    state.uid = 'u1';
    component = mount(AssociationDetailView, {
      target: document.body,
      props: { slug: 'a', kind: 'association' },
    });
    await settle();
    expect(getBellLevel).toHaveBeenCalledTimes(1);
    expect(getBellLevel).toHaveBeenCalledWith('association', 'a1');
  });
});
