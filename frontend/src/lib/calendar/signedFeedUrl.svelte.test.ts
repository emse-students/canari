import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushSync } from 'svelte';

const signAgendaFeed = vi.hoisted(() => vi.fn());
vi.mock('$lib/associations/api', () => ({
  signAgendaFeed: (...args: unknown[]) => signAgendaFeed(...args),
}));

import { createFeedSigner } from './signedFeedUrl.svelte';
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
  signAgendaFeed.mockReset();
});

describe('createFeedSigner', () => {
  it('asks for nothing while there is nothing to sign (modal closed, no selection)', () => {
    const { value, stop } = inRoot(() => createFeedSigner(() => null));
    expect(signAgendaFeed).not.toHaveBeenCalled();
    expect(value.status).toBe('idle');
    expect(value.sig).toBe('');
    stop();
  });

  it('holds the signature of the CURRENT selection and never the previous one', async () => {
    signAgendaFeed.mockImplementation((sel: AgendaFeedSelection) =>
      Promise.resolve(`sig-${sel.campus}`)
    );
    let selection = $state<AgendaFeedSelection | null>({ campus: 'gardanne' });
    const { value, stop } = inRoot(() => createFeedSigner(() => selection));
    expect(value.status).toBe('signing');
    await vi.waitFor(() => expect(value.sig).toBe('sig-gardanne'));
    expect(value.status).toBe('ready');

    selection = { campus: 'saint-etienne' };
    flushSync();
    expect(value.sig).toBe('');
    await vi.waitFor(() => expect(value.sig).toBe('sig-saint-etienne'));
    stop();
  });

  it('drops an answer that arrives after the selection moved on', async () => {
    const resolvers: Array<(sig: string) => void> = [];
    signAgendaFeed.mockImplementation(
      () => new Promise<string>((resolve) => resolvers.push(resolve))
    );
    let selection = $state<AgendaFeedSelection | null>({ campus: 'gardanne' });
    const { value, stop } = inRoot(() => createFeedSigner(() => selection));
    selection = { campus: 'saint-etienne' };
    flushSync();
    resolvers[1]('second');
    await vi.waitFor(() => expect(value.sig).toBe('second'));
    resolvers[0]('first');
    await Promise.resolve();
    expect(value.sig).toBe('second');
    stop();
  });

  it('reports a refusal as an error with no signature', async () => {
    signAgendaFeed.mockRejectedValue(new Error('403'));
    const { value, stop } = inRoot(() => createFeedSigner(() => ({ campus: 'gardanne' })));
    await vi.waitFor(() => expect(value.status).toBe('error'));
    expect(value.sig).toBe('');
    stop();
  });
});
