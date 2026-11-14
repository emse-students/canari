// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A NOTIFICATION NAMES A MEMBER BY THEIR NICKNAME IN THAT CONVERSATION (owner, 2026-11-14: "comme
 * sur Messenger, tous les pseudos"), composed by the device under the screen's block rule. Here:
 * the register's half - the scope a notification reads, the shared contract against this register,
 * the block rule applied to what is mirrored, and what reaches the native copy.
 */
const me = { id: 'me' as string | null };
vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => me.id }));
const isBlockedWith = vi.fn<(id: string) => Promise<boolean>>();
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: (id: string) => isBlockedWith(id) }));
vi.mock('$lib/stores/connectivity.svelte', () => ({ connectivity: { onReconnect: () => {} } }));
const notes = vi.hoisted(() => ({
  nickname: [] as Array<[string, string, string | null]>,
  salon: [] as Array<[string, string | null]>,
  forgotten: [] as string[],
  restated: [] as string[],
  sessions: 0,
}));
vi.mock('./nicknameMirror', () => ({
  noteMirroredNickname: (s: string, u: string, n: string | null) => notes.nickname.push([s, u, n]),
  noteMirroredSalon: (c: string, s: string | null) => notes.salon.push([c, s]),
  forgetNicknameMirror: async (u: string) => void notes.forgotten.push(u),
  noteMirroredScopeRestated: (s: string) => void notes.restated.push(s),
  noteMirrorSessionStart: () => void notes.sessions++,
}));

import {
  applyNickname,
  communityNicknameScope,
  dropNickname,
  forgetConversationNicknames,
  mirroredNickname,
  mirrorStoredNicknames,
  notificationNicknameScope,
  noteSalonCommunities,
  resetConversationNicknamesForTests,
  restateMirroredScope,
  visibleNickname,
} from './conversationNicknames.svelte';

async function settle() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  resetConversationNicknamesForTests();
  me.id = 'me';
  isBlockedWith.mockReset();
  isBlockedWith.mockResolvedValue(false);
  notes.nickname.length = 0;
  notes.salon.length = 0;
  notes.forgotten.length = 0;
  notes.restated.length = 0;
  notes.sessions = 0;
});

describe('the scope a notification reads', () => {
  it('is the conversation itself for an MLS room, the community for a placed salon', () => {
    noteSalonCommunities([{ workspaceDbId: 'w1', channels: [{ id: 'channel_c1' }] }]);
    expect(notificationNicknameScope('g1', 'group')).toBe('g1');
    expect(notificationNicknameScope('channel_c1', 'channel')).toBe('community:w1');
    expect(notificationNicknameScope('channel_c9', 'channel')).toBeNull();
    expect(notes.salon).toEqual([['c1', 'community:w1']]);
  });

  it('forgets a salon no longer listed, and notes only what changed', () => {
    noteSalonCommunities([{ workspaceDbId: 'w1', channels: [{ id: 'channel_c1' }] }]);
    noteSalonCommunities([{ workspaceDbId: 'w1', channels: [{ id: 'channel_c1' }] }]);
    noteSalonCommunities([]);
    expect(notes.salon).toEqual([
      ['c1', 'community:w1'],
      ['c1', null],
    ]);
    expect(notificationNicknameScope('channel_c1', 'channel')).toBeNull();
  });

  it('places every salon again for the next account of the install, whose copy starts afresh', () => {
    const list = [{ workspaceDbId: 'w1', channels: [{ id: 'channel_c1' }] }];
    noteSalonCommunities(list);
    me.id = 'other';
    // Before the next account's list is read, the previous account's placements are not used.
    expect(notificationNicknameScope('channel_c1', 'channel')).toBeNull();
    noteSalonCommunities(list);
    expect(notes.salon).toEqual([
      ['c1', 'community:w1'],
      ['c1', 'community:w1'],
    ]);
    expect(notificationNicknameScope('channel_c1', 'channel')).toBe('community:w1');
  });
});

describe('the shared contract (libs/contracts/notification-nickname.cases.json), against the register', () => {
  const contract = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        '..',
        'libs',
        'contracts',
        'notification-nickname.cases.json'
      ),
      'utf8'
    )
  ) as {
    book: {
      userId: string;
      scopes: Record<string, Record<string, string>>;
      channels: Record<string, string>;
    };
    cases: Array<{
      name: string;
      me: string | null;
      kind: 'group' | 'salon';
      conversation: string;
      member: string;
      expected: string | null;
    }>;
  };

  for (const c of contract.cases) {
    it(c.name, () => {
      me.id = contract.book.userId;
      for (const [scope, members] of Object.entries(contract.book.scopes)) {
        for (const [member, nickname] of Object.entries(members)) {
          applyNickname(scope, member, { nickname, setBy: 'f'.repeat(64), at: 1 });
        }
      }
      noteSalonCommunities(
        Object.entries(contract.book.channels).map(([id, scope]) => ({
          workspaceDbId: scope.replace(/^community:/, ''),
          channels: [{ id: `channel_${id}` }],
        }))
      );
      me.id = c.me;
      const scope = notificationNicknameScope(
        c.kind === 'salon' && !c.conversation.startsWith('channel_')
          ? `channel_${c.conversation}`
          : c.conversation,
        c.kind === 'salon' ? 'channel' : 'group'
      );
      expect(visibleNickname(scope, c.member)).toBe(c.expected);
    });
  }
});

describe('what the native copy receives', () => {
  it('every change, and a reset or a dropped member as none', () => {
    applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'ann', at: 1 });
    applyNickname('g1', 'bob', { nickname: null, setBy: 'ann', at: 2 });
    const scope = communityNicknameScope('w1');
    applyNickname(scope, 'bob', { nickname: 'Prez', setBy: 'ann', at: 1 });
    dropNickname(scope, 'bob');
    expect(notes.nickname).toEqual([
      ['g1', 'bob', 'Capitaine'],
      ['g1', 'bob', null],
      [scope, 'bob', 'Prez'],
      [scope, 'bob', null],
    ]);
  });

  it("the viewer's own nickname set by another only once no block is known, as on the screen", async () => {
    applyNickname('g1', 'me', { nickname: 'Chef', setBy: 'ann', at: 1 });
    // Unknown yet: the profile name, and the question is asked.
    expect(notes.nickname).toEqual([['g1', 'me', null]]);
    await settle();
    expect(isBlockedWith).toHaveBeenCalledWith('ann');
    expect(notes.nickname.at(-1)).toEqual(['g1', 'me', 'Chef']);
    expect(mirroredNickname('g1', 'me')).toBe('Chef');
  });

  it('never mirrors a nickname of the viewer whose setter stands in a block with them', async () => {
    isBlockedWith.mockResolvedValue(true);
    applyNickname('g1', 'me', { nickname: 'Insulte', setBy: 'troll', at: 1 });
    await settle();
    expect(notes.nickname.every(([, , n]) => n === null)).toBe(true);
    expect(mirroredNickname('g1', 'me')).toBeNull();
  });

  it('nor one whose block status cannot be had - the profile name, as on the screen', async () => {
    isBlockedWith.mockRejectedValue(new Error('offline'));
    applyNickname('g1', 'me', { nickname: 'Chef', setBy: 'ann', at: 1 });
    await settle();
    expect(mirroredNickname('g1', 'me')).toBeNull();
  });

  it('restates every stored register of the account, once per session', () => {
    applyNickname('g1', 'bob', { nickname: 'Capitaine', setBy: 'ann', at: 1 });
    applyNickname('g2', 'eve', { nickname: 'Eve2', setBy: 'ann', at: 1 });
    resetConversationNicknamesForTests();
    notes.nickname.length = 0;
    expect(mirrorStoredNicknames()).toBe(2);
    expect(notes.sessions).toBe(1);
    expect(notes.restated.sort()).toEqual(['g1', 'g2']);
    expect(notes.nickname).toEqual(
      expect.arrayContaining([
        ['g1', 'bob', 'Capitaine'],
        ['g2', 'eve', 'Eve2'],
      ])
    );
  });

  it('owes the session its write even when the account holds no nickname', () => {
    expect(mirrorStoredNicknames()).toBe(0);
    expect(notes.sessions).toBe(1);
  });

  it("restates a community's whole register, so what its list stopped naming leaves the copy", () => {
    const scope = communityNicknameScope('w1');
    applyNickname(scope, 'bob', { nickname: 'Prez', setBy: 'ann', at: 1 });
    notes.nickname.length = 0;
    expect(restateMirroredScope(scope)).toBe(1);
    expect(notes.restated).toEqual([scope]);
    expect(notes.nickname).toEqual([[scope, 'bob', 'Prez']]);
  });

  it('is removed at sign-out with the register', () => {
    forgetConversationNicknames('me');
    expect(notes.forgotten).toEqual(['me']);
  });
});
