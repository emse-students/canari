/**
 * The member half of an unnamed group's label: read from the tree on sight and after every change,
 * the newest read winning (docs/wiki/frontend/modules/chat.md#one-new-discussion-panel).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/users/displayName', () => ({
  resolveUserDisplayName: vi.fn(async () => null),
  getUserDisplayNameSync: (id: string) => id,
  getUserFirstNameSync: (id: string, fallback: string) =>
    ({ alice: 'Alice', bob: 'Bob' })[id] ?? fallback,
}));

import {
  bindGroupTreeReader,
  ensureGroupTreeMembers,
  groupTreeMemberIds,
  noteGroupTreeChanged,
  refreshGroupTreeMembers,
  unnamedGroupLabelOf,
} from './groupTreeMembers';
import { m } from '$lib/paraglide/messages';

/** Binds a session that holds every group, answering reads with `read`. */
function bindHeld(read: (groupId: string) => Promise<string[]>): void {
  bindGroupTreeReader({ holds: () => true, read });
}

afterEach(() => bindGroupTreeReader(null));

/** A reader whose answers the test releases one by one, in any order. */
function deferredReader() {
  const calls: { groupId: string; resolve: (ids: string[]) => void; reject: (e: Error) => void }[] =
    [];
  const reader = (groupId: string) =>
    new Promise<string[]>((resolve, reject) => calls.push({ groupId, resolve, reject }));
  return { reader, calls };
}

describe('groupTreeMembers', () => {
  it('reads a group on sight, once, and labels it by the other members', async () => {
    const reader = vi.fn(async () => ['me:d1', 'alice:d1', 'bob:d2', 'alice:d3']);
    bindHeld(reader);

    expect(unnamedGroupLabelOf('g1', 'me')).toBeNull();
    ensureGroupTreeMembers('g1');
    await vi.waitFor(() => expect(groupTreeMemberIds('g1')).toEqual(['alice', 'bob', 'me']));

    expect(reader).toHaveBeenCalledTimes(1);
    expect(unnamedGroupLabelOf('g1', 'me')).toBe(
      m.group_default_name_two({ first: 'Alice', second: 'Bob' })
    );
  });

  it('follows a departure when the tree changes', async () => {
    let leaves = ['me:d1', 'alice:d1', 'bob:d2'];
    bindHeld(async () => leaves);
    await refreshGroupTreeMembers('g1', 'test');
    leaves = ['me:d1', 'alice:d1'];
    noteGroupTreeChanged('g1', 'commit');
    await vi.waitFor(() => expect(unnamedGroupLabelOf('g1', 'me')).toBe('Alice'));
  });

  it('keeps the NEWEST read when two straddle a commit and the older answers last', async () => {
    const { reader, calls } = deferredReader();
    bindHeld(reader);
    const older = refreshGroupTreeMembers('g1', 'first');
    const newer = refreshGroupTreeMembers('g1', 'commit');
    calls[1].resolve(['me:d1', 'alice:d1']);
    await newer;
    calls[0].resolve(['me:d1', 'alice:d1', 'bob:d1']);
    await older;
    expect(groupTreeMemberIds('g1')).toEqual(['alice', 'me']);
  });

  it('asks whether a group is held and reads nothing when it is not', async () => {
    const read = vi.fn(async () => ['me:d1', 'alice:d1']);
    bindGroupTreeReader({ holds: () => false, read });
    await refreshGroupTreeMembers('g1', 'test');
    expect(read).not.toHaveBeenCalled();
    expect(groupTreeMemberIds('g1')).toBeUndefined();
  });

  it('warns once on a held group that cannot be read, however often it is drawn, and retries on a change', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const read = vi.fn(async () => {
      if (fail) throw new Error('wasm not ready');
      return ['me:d1', 'alice:d1'];
    });
    bindGroupTreeReader({ holds: () => true, read });
    ensureGroupTreeMembers('g1');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    ensureGroupTreeMembers('g1');
    ensureGroupTreeMembers('g1');
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(groupTreeMemberIds('g1')).toBeUndefined();
    fail = false;
    noteGroupTreeChanged('g1', 'commit');
    await vi.waitFor(() => expect(groupTreeMemberIds('g1')).toEqual(['alice', 'me']));
    expect(read).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('reads a group once it is held after a change, having skipped it while it was not', async () => {
    let held = false;
    const read = vi.fn(async () => ['me:d1', 'alice:d1']);
    bindGroupTreeReader({ holds: () => held, read });
    ensureGroupTreeMembers('g1');
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    held = true;
    noteGroupTreeChanged('g1', 'welcome');
    await vi.waitFor(() => expect(groupTreeMemberIds('g1')).toEqual(['alice', 'me']));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('forgets every read when the session changes', async () => {
    bindHeld(async () => ['me:d1', 'alice:d1']);
    await refreshGroupTreeMembers('g1', 'test');
    bindHeld(async () => []);
    expect(groupTreeMemberIds('g1')).toBeUndefined();
  });

  it('reads no tree on a change to a group no label was ever drawn for', async () => {
    const reader = vi.fn(async () => ['me:d1']);
    bindHeld(reader);
    noteGroupTreeChanged('key-group', 'commit');
    await Promise.resolve();
    expect(reader).not.toHaveBeenCalled();
  });

  it('reads nothing with no session bound', async () => {
    await refreshGroupTreeMembers('g1', 'test');
    ensureGroupTreeMembers('g1');
    expect(groupTreeMemberIds('g1')).toBeUndefined();
  });
});
