// @vitest-environment happy-dom
/**
 * A PUSH THAT OPENS /notifications WHILE IT IS ALREADY MOUNTED RE-READS THE LIST (Mi 9T,
 * 2026-11-17: the sanction rows were on the server and missing from the page). The event is the
 * navigation to the route the page already shows; a fresh mount reads once, by itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { flushMacrotask } from '../../test/flush';

const nav = vi.hoisted(() => ({ cb: null as null | ((n: unknown) => void) }));
const store = vi.hoisted(() => ({
  notifications: [] as unknown[],
  loading: false,
  load: vi.fn(() => Promise.resolve()),
  markAllRead: vi.fn(() => Promise.resolve()),
}));

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  afterNavigate: (cb: (n: unknown) => void) => {
    nav.cb = cb;
  },
}));
vi.mock('$lib/stores/postNotifStore.svelte', () => ({ postNotifStore: store }));
vi.mock('$lib/proposals/api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  countMyRepublicationRequests: () => Promise.resolve(0),
}));
vi.mock('$lib/follows/api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  countFollowRequests: () => Promise.resolve(0),
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  store.load.mockClear();
  store.markAllRead.mockClear();
  nav.cb = null;
});

async function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Page, { target });
  mounted.push(() => void unmount(app));
  await flushMacrotask();
  flushSync();
}
const route = (id: string | null) => (id === null ? null : { route: { id } });

describe('/notifications re-read on a push', () => {
  it('reads once on a fresh mount, even when the navigation callback fires from another route', async () => {
    await render();
    expect(store.load).toHaveBeenCalledTimes(1);
    nav.cb?.({ from: route('/dashboard'), to: route('/notifications') });
    nav.cb?.({ from: null, to: route('/notifications') });
    await flushMacrotask();
    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it('re-reads, then marks read, when the route it already shows is navigated to', async () => {
    await render();
    nav.cb?.({ from: route('/notifications'), to: route('/notifications') });
    await flushMacrotask();
    expect(store.load).toHaveBeenCalledTimes(2);
    expect(store.markAllRead).toHaveBeenCalledTimes(2);
  });
});
