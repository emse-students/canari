// @vitest-environment happy-dom
/**
 * A REQUEST TO AN AUTHOR, DRAWN FOR AN OFFICER WHO MAY NOT SEE THE POST (D38b, review of #2116).
 * The server sends `subjectId`, `subject` and `toUser` all null to such a caller; the queue then
 * says "a request to an author" and nothing more - no preview, no link to the post, no avatar and
 * no name. To an officer who sees the post, the same row names the author and links the post.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Association } from '$lib/associations/api';
import type { Proposal } from '$lib/proposals/api';
import { m } from '$lib/paraglide/messages';
import { ApiRefusalError } from '$lib/utils/apiRefusal';
import { flushMacrotask } from '../../../../test/flush';

const queue = vi.hoisted(() => ({ outgoing: [] as unknown[], avatars: [] as string[] }));

// The avatar fetches its picture; what matters here is WHOSE avatar is drawn, if any.
vi.mock('$lib/components/shared/Avatar.svelte', () => ({
  default: (_anchor: unknown, props: { userId: string }) => {
    queue.avatars.push(props.userId);
  },
}));

vi.mock('$lib/proposals/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/proposals/api')>()),
  listPendingProposals: vi.fn(() => Promise.resolve({ incoming: [], outgoing: queue.outgoing })),
  withdrawProposal: vi.fn(() => Promise.reject(new ApiRefusalError(409, null, 'decided'))),
}));

import EditProposalsTab from './EditProposalsTab.svelte';

const FROM = { id: 'a-1', name: 'Le Club', slug: 'club', logoUrl: null };

const unseen: Proposal = {
  id: 'p-unseen',
  kind: 'repost-personal',
  status: 'pending',
  subjectId: null,
  subject: null,
  from: FROM,
  to: null,
  toUser: null,
  createdAt: '2026-10-19T08:00:00.000Z',
};

const seen: Proposal = {
  id: 'p-seen',
  kind: 'repost-personal',
  status: 'pending',
  subjectId: 'post-1',
  subject: { preview: 'Une soirée', createdAt: '2026-10-18T08:00:00.000Z' },
  from: FROM,
  to: null,
  toUser: { id: 'u-author', name: 'Alice Author' },
  createdAt: '2026-10-19T08:00:00.000Z',
};

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
});

async function render(outgoing: Proposal[]): Promise<HTMLElement> {
  queue.outgoing = outgoing;
  queue.avatars = [];
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(EditProposalsTab, { target, props: { asso: FROM as unknown as Association } });
  mounted.push(() => void unmount(app));
  await flushMacrotask();
  flushSync();
  return target;
}

describe('EditProposalsTab, a request to an author', () => {
  it('tells an officer who may not see the post nothing about it', async () => {
    const target = await render([unseen]);
    const text = target.textContent ?? '';
    expect(text).toContain(m.asso_proposals_to_an_author());
    expect(text).toContain(m.asso_proposals_personal_unseen());
    expect(target.querySelector('a[href^="/posts/"]')).toBeNull();
    expect(queue.avatars).toEqual([]);
  });

  it('names the author and links the post to an officer who sees it', async () => {
    const target = await render([seen]);
    const text = target.textContent ?? '';
    expect(text).toContain(m.asso_proposals_to_author({ name: 'Alice Author' }));
    expect(text).not.toContain(m.asso_proposals_personal_unseen());
    expect(target.querySelector('a[href="/posts/post-1"]')).not.toBeNull();
    expect(queue.avatars).toEqual(['u-author']);
  });

  it('says a request was already decided after re-reading the queue, rather than erasing it', async () => {
    const target = await render([unseen]);
    const withdraw = [...target.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.asso_republications_withdraw()
    );
    expect(withdraw, 'the withdraw button is drawn').toBeTruthy();
    withdraw!.click();
    await flushMacrotask();
    await flushMacrotask();
    flushSync();
    expect(target.textContent).toContain(m.asso_republications_not_pending());
  });
});
