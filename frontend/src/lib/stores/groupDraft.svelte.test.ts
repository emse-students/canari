import { describe, it, expect, vi, afterEach } from 'vitest';
import { groupDraft } from './groupDraft.svelte';

afterEach(() => {
  groupDraft.takeFor('a');
  vi.restoreAllMocks();
});

describe('groupDraft', () => {
  it('hands the draft to the account that made it, once', () => {
    groupDraft.offer('a', [{ id: 'u1', name: 'Ada' }]);
    expect(groupDraft.pending?.owner).toBe('a');
    expect(groupDraft.takeFor('a')).toEqual([{ id: 'u1', name: 'Ada' }]);
    expect(groupDraft.pending).toBeNull();
    expect(groupDraft.takeFor('a')).toBeNull();
  });

  it("drops another account's draft, and says so", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    groupDraft.offer('a', [{ id: 'u1', name: 'Ada' }]);
    expect(groupDraft.takeFor('b')).toBeNull();
    expect(groupDraft.pending).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
