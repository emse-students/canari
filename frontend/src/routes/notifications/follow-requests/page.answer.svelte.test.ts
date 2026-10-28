// @vitest-environment happy-dom
/**
 * THE FOLLOW REQUEST INBOX (WP-F4): an answer takes the row off the list on the server's word, and a
 * request already answered or withdrawn (404) re-reads the list and says so - never a silent no-op.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { flushMacrotask } from '../../../test/flush';

const api = vi.hoisted(() => ({ list: vi.fn(), accept: vi.fn(), refuse: vi.fn() }));

vi.mock('$lib/follows/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/follows/api')>()),
  listFollowRequests: api.list,
  acceptFollowRequest: api.accept,
  refuseFollowRequest: api.refuse,
}));
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  peekUserDisplayName: (id: string) => `Name ${id}`,
}));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));
vi.mock('$lib/components/shared/Avatar.svelte', () => ({ default: () => {} }));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  api.list.mockReset();
  api.accept.mockReset();
  api.refuse.mockReset();
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

const row = (userId: string) => ({ userId, createdAt: new Date().toISOString() });
const buttonOf = (target: HTMLElement, label: string): HTMLButtonElement =>
  [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

describe('/notifications/follow-requests', () => {
  it('lists the people asking, and an acceptance takes the row off', async () => {
    api.list.mockResolvedValue([row('ann'), row('cid')]);
    api.accept.mockResolvedValue(undefined);
    const target = await render();
    expect(target.textContent).toContain('Name ann');
    expect(target.textContent).toContain('Name cid');
    buttonOf(target, m.follow_requests_accept()).click();
    await flushMacrotask();
    flushSync();
    expect(api.accept).toHaveBeenCalledWith('ann');
    expect(target.textContent).not.toContain('Name ann');
    expect(target.textContent).toContain('Name cid');
  });

  it('re-reads the list and says so when the request was already answered or withdrawn', async () => {
    api.list.mockResolvedValueOnce([row('ann')]).mockResolvedValueOnce([]);
    api.refuse.mockRejectedValue(new ApiRefusalError(404, null, 'gone'));
    const target = await render();
    buttonOf(target, m.follow_requests_refuse()).click();
    await flushMacrotask();
    flushSync();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(target.textContent).toContain(m.follow_requests_gone());
    expect(target.textContent).toContain(m.follow_requests_empty());
  });
});
