// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';

vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => 'me' }));
const isBlockedWith = vi.fn<(id: string) => Promise<boolean>>();
vi.mock('$lib/users/blocks', () => ({
  USER_BLOCKED_CODE: 'USER_BLOCKED',
  isBlockedWith: (id: string) => isBlockedWith(id),
}));
const setCommunityNickname = vi.fn();
const listCommunityNicknames = vi.fn();
vi.mock('$lib/services/ChannelService', () => ({
  channelService: {
    setCommunityNickname: (...a: unknown[]) => setCommunityNickname(...a),
    listCommunityNicknames: (...a: unknown[]) => listCommunityNicknames(...a),
  },
}));

import {
  applyCommunityNicknameEvent,
  loadCommunityNicknames,
  saveNickname,
  type NicknamePlace,
} from './nicknameActions';
import {
  communityNicknameScope,
  nicknameEntry,
  resetConversationNicknamesForTests,
} from '$lib/utils/users/conversationNicknames.svelte';

const scope = communityNicknameScope('w1');

beforeEach(() => {
  localStorage.clear();
  resetConversationNicknamesForTests();
  isBlockedWith.mockReset();
  isBlockedWith.mockResolvedValue(false);
  setCommunityNickname.mockReset();
  listCommunityNicknames.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

function group(send: (u: string, n: string | null, at: number) => Promise<boolean>): NicknamePlace {
  return { kind: 'group', scope: 'g1', send };
}

describe('saveNickname in an MLS room', () => {
  it('queues the frame FIRST, then moves the register with the same instant', async () => {
    const send = vi.fn(async () => true);
    expect(await saveNickname(group(send), 'Me', 'Bob', '  Capitaine ')).toBe('saved');
    const [userId, nickname, at] = send.mock.calls[0] as unknown as [string, string, number];
    expect([userId, nickname]).toEqual(['bob', 'Capitaine']);
    expect(nicknameEntry('g1', 'bob')).toEqual({
      nickname: 'Capitaine',
      setBy: 'me',
      at,
      verified: true,
    });
  });

  it('leaves the register untouched when the queue refuses the frame', async () => {
    expect(
      await saveNickname(
        group(async () => false),
        'me',
        'bob',
        'Capitaine'
      )
    ).toBe('not_queued');
    expect(nicknameEntry('g1', 'bob')).toBeNull();
  });

  it('sends nothing past a block, nor on an unanswered block question', async () => {
    const send = vi.fn(async () => true);
    isBlockedWith.mockResolvedValueOnce(true);
    expect(await saveNickname(group(send), 'me', 'bob', 'X')).toBe('blocked');
    isBlockedWith.mockRejectedValueOnce(new Error('offline'));
    expect(await saveNickname(group(send), 'me', 'bob', 'X')).toBe('failed');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not ask about a block to rename oneself', async () => {
    await saveNickname(
      group(async () => true),
      'me',
      'me',
      'Moi'
    );
    expect(isBlockedWith).not.toHaveBeenCalled();
  });

  it('refuses a value over the profile limit before anything is sent', async () => {
    const send = vi.fn(async () => true);
    expect(await saveNickname(group(send), 'me', 'bob', 'x'.repeat(101))).toBe('too_long');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('saveNickname in a community', () => {
  const place = (canModerate: boolean): NicknamePlace => ({
    kind: 'community',
    workspaceId: 'w1',
    canModerate,
  });

  it('writes through the server and takes its answer into the register', async () => {
    setCommunityNickname.mockResolvedValue({
      userId: 'bob',
      nickname: 'Capitaine',
      setBy: 'me',
      at: 42,
      reportSubject: 'row@42',
    });
    expect(await saveNickname(place(true), 'me', 'bob', 'Capitaine')).toBe('saved');
    expect(setCommunityNickname).toHaveBeenCalledWith('w1', 'bob', 'Capitaine');
    expect(nicknameEntry(scope, 'bob')?.reportSubject).toBe('row@42');
  });

  it('does not offer a member a write the server would refuse, but lets them clear their own', async () => {
    expect(await saveNickname(place(false), 'me', 'bob', 'Capitaine')).toBe('not_allowed');
    setCommunityNickname.mockResolvedValue({ userId: 'me', nickname: null, setBy: 'me', at: 1 });
    expect(await saveNickname(place(false), 'me', 'me', '')).toBe('saved');
    expect(setCommunityNickname).toHaveBeenCalledTimes(1);
  });

  it('maps each typed refusal to its outcome', async () => {
    const cases: [string, string][] = [
      ['NICKNAME_REQUIRES_MODERATION', 'not_allowed'],
      ['USER_BLOCKED', 'blocked'],
      ['NICKNAME_TARGET_NOT_MEMBER', 'not_member'],
      ['nickname_too_long', 'too_long'],
      ['SOMETHING_ELSE', 'failed'],
    ];
    for (const [code, outcome] of cases) {
      setCommunityNickname.mockRejectedValueOnce(new ApiRefusalError(403, code, 'refused'));
      expect(await saveNickname(place(true), 'me', 'bob', 'X')).toBe(outcome);
    }
  });
});

describe('the community register is fed by the list and the event, merged by date', () => {
  it('a list read before a later live change cannot overrule it', async () => {
    applyCommunityNicknameEvent('w1', { userId: 'bob', nickname: 'New', setBy: 'mod', at: 20 });
    listCommunityNicknames.mockResolvedValue([
      { userId: 'bob', nickname: 'Old', setBy: 'mod', at: 10 },
    ]);
    expect(await loadCommunityNicknames('w1')).toBe(true);
    expect(nicknameEntry(scope, 'bob')?.nickname).toBe('New');
  });

  it('a failed list keeps what the register held and says so', async () => {
    applyCommunityNicknameEvent('w1', { userId: 'bob', nickname: 'Kept', setBy: 'mod', at: 20 });
    listCommunityNicknames.mockRejectedValue(new Error('offline'));
    expect(await loadCommunityNicknames('w1')).toBe(false);
    expect(nicknameEntry(scope, 'bob')?.nickname).toBe('Kept');
  });

  it('drops a held entry the list no longer names - a member who left, a membership made afresh', async () => {
    applyCommunityNicknameEvent('w1', { userId: 'bob', nickname: 'Gone', setBy: 'mod', at: 5 });
    listCommunityNicknames.mockResolvedValue([]);
    expect(await loadCommunityNicknames('w1')).toBe(true);
    expect(nicknameEntry(scope, 'bob')).toBeNull();
  });

  it('keeps an entry an event brought while the list was in flight', async () => {
    let answer: (v: unknown[]) => void = () => {};
    listCommunityNicknames.mockReturnValue(new Promise((r) => (answer = r)));
    const loading = loadCommunityNicknames('w1');
    applyCommunityNicknameEvent('w1', { userId: 'bob', nickname: 'Fresh', setBy: 'mod', at: 30 });
    answer([]);
    expect(await loading).toBe(true);
    expect(nicknameEntry(scope, 'bob')?.nickname).toBe('Fresh');
  });

  it('an event naming nobody is accused, not applied', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    applyCommunityNicknameEvent('w1', { nickname: 'X' });
    expect(error).toHaveBeenCalled();
  });
});
