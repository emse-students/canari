// @vitest-environment happy-dom
/**
 * THE WAY TO THE REQUESTS INBOX IS DRAWN FROM ONE COUNT (D38b, review of #2116). `/notifications`
 * only needs to know whether requests wait, so it asks the count route alone - never the inbox,
 * whose per-request audience counts are the expensive part - and draws no link for zero.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { flushMacrotask } from '../../test/flush';

const api = vi.hoisted(() => ({ count: vi.fn(), list: vi.fn() }));

vi.mock('$lib/proposals/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/proposals/api')>()),
  countMyRepublicationRequests: api.count,
  listMyRepublicationRequests: api.list,
}));
const follows = vi.hoisted(() => ({ count: vi.fn(), list: vi.fn() }));
vi.mock('$lib/follows/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/follows/api')>()),
  countFollowRequests: follows.count,
  listFollowRequests: follows.list,
}));
vi.mock('$lib/stores/postNotifStore.svelte', () => ({
  postNotifStore: {
    notifications: [],
    loading: false,
    load: vi.fn(() => Promise.resolve()),
    markAllRead: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  api.count.mockReset();
  api.list.mockReset();
  follows.count.mockReset();
  follows.list.mockReset();
});

async function render(): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Page, { target });
  mounted.push(() => void unmount(app));
  await flushMacrotask();
  flushSync();
  return target;
}

describe('/notifications, the way to the requests inbox', () => {
  it('reads the count route alone, and draws the link with that count', async () => {
    follows.count.mockResolvedValue(0);
    api.count.mockResolvedValue(2);
    const target = await render();
    expect(api.count).toHaveBeenCalledTimes(1);
    expect(api.list).not.toHaveBeenCalled();
    expect(target.textContent).toContain(m.republication_requests_banner({ count: 2 }));
  });

  it('draws no link when nothing waits', async () => {
    follows.count.mockResolvedValue(0);
    api.count.mockResolvedValue(0);
    const target = await render();
    expect(target.textContent).not.toContain(m.republication_requests_banner({ count: 0 }));
  });

  it('draws the way to the FOLLOW request inbox from its own count route (WP-F4)', async () => {
    api.count.mockResolvedValue(0);
    follows.count.mockResolvedValue(3);
    const target = await render();
    expect(follows.count).toHaveBeenCalledTimes(1);
    expect(follows.list).not.toHaveBeenCalled();
    expect(target.textContent).toContain(m.follow_requests_banner({ count: 3 }));
    expect(target.querySelector('a[href$="/notifications/follow-requests"]')).not.toBeNull();
  });

  it('draws no follow link when none waits', async () => {
    api.count.mockResolvedValue(0);
    follows.count.mockResolvedValue(0);
    const target = await render();
    expect(target.textContent).not.toContain(m.follow_requests_banner({ count: 0 }));
  });
});
