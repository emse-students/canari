// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const me = { id: 'me' as string | null };
vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => me.id }));
const isBlockedWith = vi.fn<(id: string) => Promise<boolean>>();
vi.mock('$lib/users/blocks', () => ({
  isBlockedWith: (id: string) => isBlockedWith(id),
}));
const reconnectListeners = vi.hoisted((): Array<() => void> => []);
vi.mock('$lib/stores/connectivity.svelte', () => ({
  connectivity: { onReconnect: (fn: () => void) => reconnectListeners.push(fn) },
}));

import {
  applyNickname,
  boundedNicknameAt,
  communityNicknameScope,
  forgetConversationNicknames,
  mergeBundleNicknames,
  NICKNAME_CLOCK_SKEW_MS,
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
    expect(nicknameEntry('g1', 'BOB')).toEqual({
      nickname: 'Capitaine',
      setBy: 'ann',
      at: 10,
      verified: true,
    });
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

  it('restates its whole register, resets included, for the join push', () => {
    applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'ann', at: 10 });
    applyNickname('g1', 'cy', { nickname: null, setBy: 'cy', at: 11 });
    expect(nicknameEntries('g1')).toHaveLength(2);
  });

  it('is kept per account: another account on the install reads nothing, sign-out forgets it', () => {
    applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'ann', at: 10 });
    me.id = 'other';
    expect(visibleNickname('g1', 'bob')).toBeNull();
    me.id = 'me';
    expect(visibleNickname('g1', 'bob')).toBe('Capitaine');
    forgetConversationNicknames('me');
    expect(Object.keys(localStorage).some((k) => k.startsWith('canari_nicknames'))).toBe(false);
    expect(visibleNickname('g1', 'bob')).toBeNull();
  });
});

describe('a join push restates the register - unverified, bounded, members only', () => {
  const members = new Set(['me', 'ann', 'bob', 'cy']);
  const serverAt = 1_000_000;

  it('takes entries naming members, marked unverified, and the same bundle twice changes nothing', () => {
    const wire = [
      { userId: 'bob', nickname: 'Capitaine', setBy: 'ann', at: 10 },
      { userId: 'cy', nickname: null, setBy: 'cy', at: 11 },
    ];
    expect(mergeBundleNicknames('g9', wire, { members, serverAt })).toBe(2);
    expect(visibleNickname('g9', 'bob')).toBe('Capitaine');
    expect(nicknameEntry('g9', 'bob')?.verified).toBe(false);
    expect(mergeBundleNicknames('g9', wire, { members, serverAt })).toBe(0);
  });

  it('refuses an entry whose target or setter is no member, and malformed ones', () => {
    const wire = [
      { userId: 'stranger', nickname: 'X', setBy: 'ann', at: 1 },
      { userId: 'bob', nickname: 'X', setBy: 'stranger', at: 1 },
      { nickname: 'X', setBy: 'ann', at: 1 },
      42,
      null,
    ];
    expect(mergeBundleNicknames('g9', wire, { members, serverAt })).toBe(0);
  });

  it('takes no more entries than the group has members', () => {
    const wire = ['me', 'ann', 'bob', 'cy', 'me', 'ann'].map((userId, i) => ({
      userId,
      nickname: `N${i}`,
      setBy: 'ann',
      at: i + 1,
    }));
    expect(mergeBundleNicknames('g9', wire, { members, serverAt })).toBe(4);
  });

  it('never replaces an authenticated entry, whatever its date - and is replaced by one', () => {
    applyNickname('g9', 'bob', { nickname: 'Vrai', setBy: 'cy', at: 5 });
    const forged = [{ userId: 'bob', nickname: 'Faux', setBy: 'ann', at: 900_000 }];
    expect(mergeBundleNicknames('g9', forged, { members, serverAt })).toBe(0);
    expect(visibleNickname('g9', 'bob')).toBe('Vrai');

    mergeBundleNicknames('g9', [{ userId: 'cy', nickname: 'Faux', setBy: 'ann', at: 900_000 }], {
      members,
      serverAt,
    });
    // An older AUTHENTICATED statement still supersedes the unverified one.
    expect(applyNickname('g9', 'cy', { nickname: 'Vrai', setBy: 'bob', at: 1 })).toBe(true);
    expect(visibleNickname('g9', 'cy')).toBe('Vrai');
  });

  it('dates an entry no later than the server time of its bundle allows', () => {
    mergeBundleNicknames('g9', [{ userId: 'bob', nickname: 'X', setBy: 'ann', at: 9e15 }], {
      members,
      serverAt,
    });
    expect(nicknameEntry('g9', 'bob')?.at).toBe(serverAt + NICKNAME_CLOCK_SKEW_MS);
  });

  it('an unverified entry naming the viewer as its own setter still waits for the block answer', async () => {
    isBlockedWith.mockResolvedValue(true);
    mergeBundleNicknames('g9', [{ userId: 'me', nickname: 'Insult', setBy: 'me', at: 1 }], {
      members,
      serverAt,
    });
    expect(visibleNickname('g9', 'me')).toBeNull();
    await settle();
    expect(isBlockedWith).toHaveBeenCalledWith('me');
    expect(visibleNickname('g9', 'me')).toBeNull();
  });
});

describe('the sender clock is bounded by the server', () => {
  it('clamps a date past the server time plus the skew, and keeps an honest one', () => {
    expect(boundedNicknameAt(9e15, 1000)).toBe(1000 + NICKNAME_CLOCK_SKEW_MS);
    expect(boundedNicknameAt(900, 1000)).toBe(900);
    expect(boundedNicknameAt(900, undefined)).toBe(900);
  });

  it('a future-dated nickname cannot freeze the name: a reset sent after it wins', () => {
    const serverAt = 1_000_000;
    applyNickname('g1', 'bob', {
      nickname: 'Gel',
      setBy: 'ann',
      at: boundedNicknameAt(9e15, serverAt),
    });
    const later = serverAt + 2 * NICKNAME_CLOCK_SKEW_MS;
    expect(
      applyNickname('g1', 'bob', {
        nickname: null,
        setBy: 'bob',
        at: boundedNicknameAt(later, later),
      })
    ).toBe(true);
    expect(visibleNickname('g1', 'bob')).toBeNull();
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

  it('asks again once the link comes back when the ask failed - a failure is not an answer', async () => {
    applyNickname('g1', 'me', { nickname: 'Chef', setBy: 'friend', at: 1 });
    isBlockedWith.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    visibleNickname('g1', 'me');
    await settle();
    expect(visibleNickname('g1', 'me')).toBeNull();
    await settle();
    // No re-ask on a mere read: the failure is a state, lifted by the reconnect.
    expect(isBlockedWith).toHaveBeenCalledTimes(1);
    for (const listener of reconnectListeners) listener();
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
