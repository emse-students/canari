import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));
const list = vi.hoisted(() => vi.fn());
vi.mock('./postIdentity', () => ({ listPostAsAssociations: list }));

import { forgetReaderCaches } from '$lib/utils/sharedCache';
import { canPostAsAssociation } from './postAsAccess.svelte';

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  forgetReaderCaches();
  list.mockReset();
});

describe('canPostAsAssociation', () => {
  it('is false until the picker list answers, then true when it names an association', async () => {
    list.mockResolvedValue([{ id: 'a' }]);
    expect(canPostAsAssociation()).toBe(false);
    await settle();
    expect(canPostAsAssociation()).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('is false for an account the picker offers no association to', async () => {
    list.mockResolvedValue([]);
    canPostAsAssociation();
    await settle();
    expect(canPostAsAssociation()).toBe(false);
  });

  it('asks again after a failure, and does not call a failure a no', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    list.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([{ id: 'a' }]);
    canPostAsAssociation();
    await settle();
    expect(error).toHaveBeenCalled();
    expect(canPostAsAssociation()).toBe(false); // asks again
    await settle();
    expect(canPostAsAssociation()).toBe(true);
    error.mockRestore();
  });

  it('forgets the answer, and drops one in flight, when the reader changes', async () => {
    list.mockResolvedValueOnce([{ id: 'a' }]);
    canPostAsAssociation();
    forgetReaderCaches(); // sign-out before the answer lands
    await settle();
    list.mockResolvedValue([]);
    expect(canPostAsAssociation()).toBe(false);
    await settle();
    expect(canPostAsAssociation()).toBe(false);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
