import { describe, expect, it } from 'vitest';
import { awaitExternalCommitVerdict, openExternalCommitWindow } from './externalCommitVerdict';

/** Lets every queued microtask run, so a waiter that could settle has settled. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('externalCommitVerdict', () => {
  it('returns at once, having waited for nothing, when no commit of this device is in flight', async () => {
    expect(await awaitExternalCommitVerdict({}, 'g')).toBe(false);
  });

  it('holds a reader until the window closes, then says it waited', async () => {
    const owner = {};
    const close = openExternalCommitWindow(owner, 'g');
    let settled: boolean | undefined;
    void awaitExternalCommitVerdict(owner, 'g').then((w) => (settled = w));
    await flush();
    expect(settled).toBeUndefined();

    close();
    await flush();
    expect(settled).toBe(true);
  });

  it('waits through a next attempt that opens a new window as the last one closes', async () => {
    const owner = {};
    const first = openExternalCommitWindow(owner, 'g');
    let settled = false;
    void awaitExternalCommitVerdict(owner, 'g').then(() => (settled = true));
    first();
    const second = openExternalCommitWindow(owner, 'g');
    await flush();
    expect(settled).toBe(false);

    second();
    await flush();
    expect(settled).toBe(true);
  });

  it('a late close of an earlier window does not close the one a later attempt opened', async () => {
    const owner = {};
    const first = openExternalCommitWindow(owner, 'g');
    first();
    const second = openExternalCommitWindow(owner, 'g');
    first();
    let settled = false;
    void awaitExternalCommitVerdict(owner, 'g').then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    second();
    await flush();
    expect(settled).toBe(true);
  });

  it('is scoped to its service instance and its group', async () => {
    const owner = {};
    openExternalCommitWindow(owner, 'g');
    expect(await awaitExternalCommitVerdict({}, 'g')).toBe(false);
    expect(await awaitExternalCommitVerdict(owner, 'other')).toBe(false);
  });
});
