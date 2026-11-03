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
import { REPOST_PERSONAL_AUDIENCE_CHANGED, type RepublicationRequest } from '$lib/proposals/api';
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

/**
 * AN INSTITUTION'S REQUEST WARNS OF ITS POTENTIAL AUDIENCE (owner, 2026-11-02), drawn from what the
 * server read of its rules and members - and nothing is drawn for an association's request.
 */
describe("the inbox, an institution's potential audience", () => {
  async function render(details: RepublicationRequest['details']): Promise<HTMLElement> {
    api.list.mockResolvedValue({ incoming: [{ ...request, details }] });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(Page, { target });
    mounted.push(() => void unmount(app));
    await settle();
    return target;
  }

  it('says everyone plainly, and the staff side, for an institution addressing everyone', async () => {
    const target = await render({
      ...request.details!,
      institutionAudience: {
        everyone: true,
        spaces: [{ campus: null, formation: null }],
        staffMembers: true,
        fingerprint: 'fp-everyone',
      },
    });
    const text = target.querySelector('[data-testid="institution-audience-warning"]')?.textContent;
    expect(text).toContain(m.republication_requests_audience_everyone());
    expect(text).toContain(m.republication_requests_audience_staff());
  });

  it('names the spaces of an institution that does not address everyone, without staff', async () => {
    const target = await render({
      ...request.details!,
      institutionAudience: {
        everyone: false,
        spaces: [{ campus: 'gardanne', formation: null }],
        staffMembers: false,
        fingerprint: 'fp-gardanne',
      },
    });
    const text = target.querySelector('[data-testid="institution-audience-warning"]')?.textContent;
    expect(text).toContain(m.republication_requests_audience_any_formation());
    expect(text).toContain(m.profile_campus_gardanne());
    expect(text).not.toContain(m.republication_requests_audience_everyone());
    expect(text).not.toContain(m.republication_requests_audience_staff());
    // Its members are always named, also when it has rules (review of #2965).
    expect(text).toContain(m.republication_requests_audience_members());
  });

  it('accepts with the fingerprint it showed; a changed audience re-reads the warning and says why', async () => {
    const shown = {
      ...request.details!,
      institutionAudience: {
        everyone: false,
        spaces: [{ campus: 'gardanne', formation: null }],
        staffMembers: false,
        fingerprint: 'fp-before',
      },
    };
    const now = {
      ...request.details!,
      institutionAudience: {
        everyone: true,
        spaces: [{ campus: null, formation: null }],
        staffMembers: true,
        fingerprint: 'fp-after',
      },
    };
    api.list
      .mockResolvedValueOnce({ incoming: [{ ...request, details: shown }] })
      .mockResolvedValueOnce({ incoming: [{ ...request, details: now }] });
    api.accept.mockRejectedValue(
      new ApiRefusalError(409, REPOST_PERSONAL_AUDIENCE_CHANGED, 'refused')
    );
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(Page, { target });
    mounted.push(() => void unmount(app));
    await settle();
    const accept = [...target.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.republication_requests_accept()
    );
    accept!.click();
    await settle();
    await settle();
    expect(api.accept).toHaveBeenCalledWith('r-1', { audienceFingerprint: 'fp-before' });
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(target.textContent).toContain(m.republication_requests_audience_changed());
    // The refreshed warning is the one now drawn: the request is still there to answer again.
    expect(
      target.querySelector('[data-testid="institution-audience-warning"]')?.textContent
    ).toContain(m.republication_requests_audience_everyone());
  });

  it("draws no warning for an association's request", async () => {
    const target = await render({ ...request.details!, institutionAudience: null });
    expect(target.querySelector('[data-testid="institution-audience-warning"]')).toBeNull();
  });
});
