// @vitest-environment happy-dom
/**
 * AN ACCEPTANCE THE SERVER VOIDED SAYS WHY (D38b, review of #2116). When the member who asked no
 * longer speaks for the association, the server voids the request and answers 409 with the code
 * `PROPOSAL_SENDER_GONE`; the inbox says so, rather than "already decided", and re-reads the list.
 * A 409 without that code keeps the "already decided" line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { ApiRefusalError } from '$lib/utils/apiRefusal';
import type { RepublicationRequest } from '$lib/proposals/api';
import { m } from '$lib/paraglide/messages';
import { flushMacrotask } from '../../../test/flush';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  accept: vi.fn(),
}));

vi.mock('$lib/proposals/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/proposals/api')>()),
  listMyRepublicationRequests: api.list,
  acceptProposal: api.accept,
}));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: vi.fn() }));

import Page from './+page.svelte';

const request: RepublicationRequest = {
  id: 'r-1',
  kind: 'repost-personal',
  status: 'pending',
  subjectId: 'post-1',
  from: { id: 'a-1', name: 'Le Club', slug: 'club', logoUrl: null },
  proposedBy: { id: 'u-asker', name: 'Paul Proposer' },
  details: { preview: 'Une soirée', createdAt: '2026-10-18T08:00:00.000Z', newlyReached: 3 },
  createdAt: '2026-10-19T08:00:00.000Z',
};

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  api.list.mockReset();
  api.accept.mockReset();
});

async function settle() {
  await flushMacrotask();
  flushSync();
}

async function acceptRefusedWith(code: string | null): Promise<string> {
  api.list.mockResolvedValue({ incoming: [request] });
  api.accept.mockRejectedValue(new ApiRefusalError(409, code, 'refused'));
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Page, { target });
  mounted.push(() => void unmount(app));
  await settle();
  const accept = [...target.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.republication_requests_accept()
  );
  expect(accept, 'the accept button is drawn').toBeTruthy();
  accept!.click();
  await settle();
  await settle();
  return target.textContent ?? '';
}

describe('the inbox, an acceptance refused with 409', () => {
  it('says the asker no longer speaks for the association, and re-reads the list', async () => {
    const text = await acceptRefusedWith('PROPOSAL_SENDER_GONE');
    expect(text).toContain(m.republication_requests_sender_gone());
    expect(text).not.toContain(m.asso_republications_not_pending());
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('keeps "already decided" for a 409 without that code', async () => {
    const text = await acceptRefusedWith(null);
    expect(text).toContain(m.asso_republications_not_pending());
    expect(text).not.toContain(m.republication_requests_sender_gone());
  });
});
