// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushSync } from 'svelte';

const requestAgendaSubscription = vi.hoisted(() => vi.fn());
const revokeAgendaSubscriptions = vi.hoisted(() => vi.fn());
vi.mock('$lib/associations/api', async (importActual) => ({
  ...(await importActual<typeof import('$lib/associations/api')>()),
  requestAgendaSubscription: (...args: unknown[]) => requestAgendaSubscription(...args),
  revokeAgendaSubscriptions: (...args: unknown[]) => revokeAgendaSubscriptions(...args),
}));

import { agendaSubscriptionIcsPath, SocialApiError } from '$lib/associations/api';
import { createSubscriptionLink } from './subscriptionLink.svelte';
import type { AgendaFeedSelection } from '$lib/associations/api';

/** Runs `body` inside an effect root, the way a component's initialisation would. */
function inRoot<T>(body: () => T): { value: T; stop: () => void } {
  let value!: T;
  const stop = $effect.root(() => {
    value = body();
  });
  flushSync();
  return { value, stop };
}

beforeEach(() => {
  requestAgendaSubscription.mockReset();
  revokeAgendaSubscriptions.mockReset();
});

describe('createSubscriptionLink', () => {
  it('asks for nothing while there is nothing to ask (modal closed, no selection)', () => {
    const { value, stop } = inRoot(() => createSubscriptionLink(() => null));
    expect(requestAgendaSubscription).not.toHaveBeenCalled();
    expect(value.status).toBe('idle');
    expect(value.token).toBe('');
    stop();
  });

  it('holds the token of the CURRENT selection and never the previous one', async () => {
    requestAgendaSubscription.mockImplementation((sel: AgendaFeedSelection) =>
      Promise.resolve(`token-${sel.campus}`)
    );
    let selection = $state<AgendaFeedSelection | null>({ campus: 'gardanne' });
    const { value, stop } = inRoot(() => createSubscriptionLink(() => selection));
    expect(value.status).toBe('signing');
    await vi.waitFor(() => expect(value.token).toBe('token-gardanne'));
    expect(value.status).toBe('ready');

    selection = { campus: 'saint-etienne' };
    flushSync();
    expect(value.token).toBe('');
    await vi.waitFor(() => expect(value.token).toBe('token-saint-etienne'));
    stop();
  });

  it('drops an answer that arrives after the selection moved on', async () => {
    const resolvers: Array<(token: string) => void> = [];
    requestAgendaSubscription.mockImplementation(
      () => new Promise<string>((resolve) => resolvers.push(resolve))
    );
    let selection = $state<AgendaFeedSelection | null>({ campus: 'gardanne' });
    const { value, stop } = inRoot(() => createSubscriptionLink(() => selection));
    selection = { campus: 'saint-etienne' };
    flushSync();
    resolvers[1]('second');
    await vi.waitFor(() => expect(value.token).toBe('second'));
    resolvers[0]('first');
    await Promise.resolve();
    expect(value.token).toBe('second');
    stop();
  });

  it('reports a 403 refusal as an error with no token', async () => {
    requestAgendaSubscription.mockRejectedValue(
      new SocialApiError('forbidden', 'AGENDA_SELECTION_FORBIDDEN', 403)
    );
    const { value, stop } = inRoot(() => createSubscriptionLink(() => ({ campus: 'gardanne' })));
    await vi.waitFor(() => expect(value.status).toBe('error'));
    expect(value.token).toBe('');
    stop();
  });

  it('reports a 503 as unavailable, not as a refusal', async () => {
    requestAgendaSubscription.mockRejectedValue(new SocialApiError('down', null, 503));
    const { value, stop } = inRoot(() => createSubscriptionLink(() => ({ campus: 'gardanne' })));
    await vi.waitFor(() => expect(value.status).toBe('unavailable'));
    expect(value.token).toBe('');
    stop();
  });

  it('reports a transport failure as unavailable', async () => {
    requestAgendaSubscription.mockRejectedValue(new TypeError('Failed to fetch'));
    const { value, stop } = inRoot(() => createSubscriptionLink(() => ({ campus: 'gardanne' })));
    await vi.waitFor(() => expect(value.status).toBe('unavailable'));
    stop();
  });

  it('revoke() ends every link, then asks again: the new token replaces the old', async () => {
    let minted = 0;
    requestAgendaSubscription.mockImplementation(() => Promise.resolve(`token-${++minted}`));
    revokeAgendaSubscriptions.mockResolvedValue(1);
    const { value, stop } = inRoot(() => createSubscriptionLink(() => ({ associationId: 'a1' })));
    await vi.waitFor(() => expect(value.token).toBe('token-1'));
    await value.revoke();
    flushSync();
    expect(revokeAgendaSubscriptions).toHaveBeenCalledTimes(1);
    expect(value.revokeStatus).toBe('revoked');
    await vi.waitFor(() => expect(value.token).toBe('token-2'));
    expect(requestAgendaSubscription).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a failed revocation is said, and asks for no new link', async () => {
    requestAgendaSubscription.mockResolvedValue('token-1');
    revokeAgendaSubscriptions.mockRejectedValue(new TypeError('Failed to fetch'));
    const { value, stop } = inRoot(() => createSubscriptionLink(() => ({ associationId: 'a1' })));
    await vi.waitFor(() => expect(value.token).toBe('token-1'));
    await value.revoke();
    flushSync();
    expect(value.revokeStatus).toBe('failed');
    expect(requestAgendaSubscription).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('the subscription URL', () => {
  it('carries the token ALONE: no selection, no signature, no window', () => {
    const path = agendaSubscriptionIcsPath('0000.abc_-9');
    const q = new URLSearchParams(path.split('?')[1]);
    expect([...q.keys()]).toEqual(['token']);
    expect(q.get('token')).toBe('0000.abc_-9');
    expect(path.startsWith('/api/associations/calendar/feed.ics?')).toBe(true);
  });
});
