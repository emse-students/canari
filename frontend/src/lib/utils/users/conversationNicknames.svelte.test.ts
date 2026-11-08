// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const me = { id: 'me' as string | null };
vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => me.id }));
const isBlockedWith = vi.fn<(id: string) => Promise<boolean>>();
vi.mock('$lib/users/blocks', () => ({
  isBlockedWith: (id: string) => isBlockedWith(id),
}));

import {
  applyNickname,
  communityNicknameScope,
  mergeNicknameEntries,
  nicknameEntries,
  nicknameEntry,
  nicknameSupersedes,
  resetConversationNicknamesForTests,
  visibleNickname,
} from './conversationNicknames.svelte';

/** Lets the microtask-scheduled block ask and its answer land. */
async function settle() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  resetConversationNicknamesForTests();
  me.id = 'me';
  isBlockedWith.mockReset();
  isBlockedWith.mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('nicknameSupersedes - one order for every device', () => {
  it('lets the strictly later statement win, whatever arrives first', () => {
    const older = { nickname: 'A', setBy: 'x', at: 1 };
    const newer = { nickname: 'B', setBy: 'y', at: 2 };
    expect(nicknameSupersedes(newer, older)).toBe(true);
    expect(nicknameSupersedes(older, newer)).toBe(false);
  });

  it('breaks a tie the same way on both sides: a reset first, then the larger setter+name', () => {
    const set = { nickname: 'A', setBy: 'x', at: 5 };
    const reset = { nickname: null, setBy: 'x', at: 5 };
    expect(nicknameSupersedes(reset, set)).toBe(true);
    expect(nicknameSupersedes(set, reset)).toBe(false);
    const a = { nickname: 'A', setBy: 'x', at: 5 };
    const b = { nickname: 'B', setBy: 'x', at: 5 };
    expect(nicknameSupersedes(b, a)).toBe(true);
    expect(nicknameSupersedes(a, b)).toBe(false);
  });
});

describe('the MLS register', () => {
  it('keeps the newest statement and ignores a replayed older one', () => {
    expect(applyNickname('g1', 'Bob', { nickname: 'Capitaine', setBy: 'Ann', at: 10 })).toBe(true);
    expect(applyNickname('g1', 'bob', { nickname: 'Old', setBy: 'ann', at: 5 })).toBe(false);
    expect(nicknameEntry('g1', 'BOB')).toEqual({ nickname: 'Capitaine', setBy: 'ann', at: 10 });
  });

  it('dates a reset like a set, so a late older set cannot resurrect a cleared name', () => {
    applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'ann', at: 10 });
    applyNickname('g1', 'bob', { nickname: null, setBy: 'bob', at: 20 });
    expect(applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'ann', at: 15 })).toBe(false);
    expect(visibleNickname('g1', 'bob')).toBeNull();
  });

  it('never leaks to another conversation, nor to a call without a scope', () => {
    applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'ann', at: 10 });
    expect(visibleNickname('g2', 'bob')).toBeNull();
    expect(visibleNickname(undefined, 'bob')).toBeNull();
    expect(visibleNickname(null, 'bob')).toBeNull();
  });

  it('refuses a value the profile rule refuses, and normalizes what it keeps', () => {
    expect(applyNickname('g1', 'bob', { nickname: 'x'.repeat(101), setBy: 'ann', at: 1 })).toBe(
      false
    );
    applyNickname('g1', 'bob', { nickname: '  Cap​itaine ', setBy: 'ann', at: 2 });
    expect(visibleNickname('g1', 'bob')).toBe('Capitaine');
  });

  it('survives a reload (localStorage), keyed by the conversation', () => {
    applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'ann', at: 10 });
    resetConversationNicknamesForTests();
    expect(visibleNickname('g1', 'bob')).toBe('Capitaine');
  });

  it('restates its whole register, resets included, for a bundle; a merge takes only what is newer', () => {
    applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'ann', at: 10 });
    applyNickname('g1', 'cy', { nickname: null, setBy: 'cy', at: 11 });
    const wire = nicknameEntries('g1');
    expect(wire).toHaveLength(2);

    // A late joiner's empty register takes everything from one bundle.
    expect(mergeNicknameEntries('g9', wire)).toBe(2);
    expect(visibleNickname('g9', 'bob')).toBe('Capitaine');
    // The same bundle again changes nothing.
    expect(mergeNicknameEntries('g9', wire)).toBe(0);
    // An entry naming nobody, or malformed, is skipped.
    expect(mergeNicknameEntries('g9', [{ nickname: 'X', setBy: 'a', at: 99 }, 42, null])).toBe(0);
  });
});

describe('a community register', () => {
  it('is kept in memory only - the server holds it', () => {
    const scope = communityNicknameScope('w1');
    applyNickname(scope, 'bob', {
      nickname: 'Capitaine',
      setBy: 'mod',
      at: 10,
      reportSubject: 's',
    });
    expect(nicknameEntry(scope, 'bob')?.reportSubject).toBe('s');
    expect(Object.keys(localStorage).some((k) => k.includes('community'))).toBe(false);
    resetConversationNicknamesForTests();
    expect(visibleNickname(scope, 'bob')).toBeNull();
  });
});

describe('a blocked setter cannot rename the blocker', () => {
  it('shows a nickname of the viewer only once the setter is known to stand in no block', async () => {
    applyNickname('g1', 'me', { nickname: 'Insult', setBy: 'troll', at: 1 });
    isBlockedWith.mockResolvedValue(true);
    expect(visibleNickname('g1', 'me')).toBeNull();
    await settle();
    expect(isBlockedWith).toHaveBeenCalledWith('troll');
    expect(visibleNickname('g1', 'me')).toBeNull();
    // Asked once per pair, not once per read.
    expect(isBlockedWith).toHaveBeenCalledTimes(1);
  });

  it('shows it once the answer is clear', async () => {
    applyNickname('g1', 'me', { nickname: 'Chef', setBy: 'friend', at: 1 });
    expect(visibleNickname('g1', 'me')).toBeNull();
    await settle();
    expect(visibleNickname('g1', 'me')).toBe('Chef');
  });

  it('asks again on the next read when the ask failed - a failure is not an answer', async () => {
    applyNickname('g1', 'me', { nickname: 'Chef', setBy: 'friend', at: 1 });
    isBlockedWith.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    visibleNickname('g1', 'me');
    await settle();
    expect(visibleNickname('g1', 'me')).toBeNull();
    await settle();
    expect(isBlockedWith).toHaveBeenCalledTimes(2);
    expect(visibleNickname('g1', 'me')).toBe('Chef');
  });

  it('never asks about a nickname of someone else, nor one the viewer set themselves', async () => {
    applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'troll', at: 1 });
    applyNickname('g1', 'me', { nickname: 'Moi', setBy: 'me', at: 1 });
    expect(visibleNickname('g1', 'bob')).toBe('Capitaine');
    expect(visibleNickname('g1', 'me')).toBe('Moi');
    await settle();
    expect(isBlockedWith).not.toHaveBeenCalled();
  });
});
