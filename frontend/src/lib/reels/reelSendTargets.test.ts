import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '$lib/types';
import { m } from '$lib/paraglide/messages';
import {
  isReelSendListed,
  reelSendCandidates,
  reelSendFailedName,
  reelSendFailedNotice,
  reelSendKeyOf,
  reelSendPlan,
  reelSendSections,
  REEL_SEND_RECENT_COUNT,
  toggleReelTarget,
} from './reelSendTargets';
import { readGroupMembersOnceReady, userIdsOfIdentities } from './reelSendBridge';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';

function convo(over: Partial<Conversation> & { id: string; name: string }): [string, Conversation] {
  return [
    over.id,
    {
      contactName: over.name,
      messages: [],
      lifecycle: 'active',
      mlsStateHex: null,
      conversationType: 'group',
      ...over,
    } as Conversation,
  ];
}

describe('isReelSendListed (15.8)', () => {
  const [, group] = convo({ id: 'g1', name: 'G' });
  it('lists a group and a DM the member belongs to', () => {
    expect(isReelSendListed(group, new Set())).toBe(true);
    const [, dm] = convo({
      id: 'd1',
      name: 'D',
      conversationType: 'direct',
      directPeerId: PEER,
    });
    expect(isReelSendListed(dm, new Set())).toBe(true);
  });

  it('never lists a salon (RC-8 has not shipped), by type or by its id', () => {
    const [, byType] = convo({ id: 'g2', name: 'S', conversationType: 'channel' });
    const [, byId] = convo({ id: 'channel_abc', name: 'S2' });
    expect(isReelSendListed(byType, new Set())).toBe(false);
    expect(isReelSendListed(byId, new Set())).toBe(false);
  });

  it('leaves out a conversation the member left, and a pending invitation', () => {
    const [, left] = convo({ id: 'g3', name: 'L', lifecycle: 'removed' });
    const [, invite] = convo({
      id: 'g4',
      name: 'I',
      lifecycle: 'pending',
      awaitingAdmission: true,
    });
    expect(isReelSendListed(left, new Set())).toBe(false);
    expect(isReelSendListed(invite, new Set())).toBe(false);
  });

  it('keeps a group that is merely not ready yet: it queues like any message', () => {
    const [, notReady] = convo({ id: 'g5', name: 'N', lifecycle: 'pending' });
    expect(isReelSendListed(notReady, new Set())).toBe(true);
  });

  it('leaves out a DM with a person the member blocked, and only that DM', () => {
    const [, dm] = convo({ id: 'd2', name: 'B', conversationType: 'direct', directPeerId: PEER });
    expect(isReelSendListed(dm, new Set([PEER]))).toBe(false);
    expect(isReelSendListed(dm, new Set(['someone-else']))).toBe(true);
  });
});

describe('reelSendCandidates', () => {
  const rows = [
    convo({ id: 'g-old', name: 'Old news', lastMessageAt: 1 }),
    convo({ id: 'g-new', name: 'New thing', lastMessageAt: 9 }),
    convo({ id: 'channel_x', name: 'Salon', lastMessageAt: 20 }),
  ];
  const base = { currentUserId: ME, peerNames: {}, blockedPeerIds: new Set<string>() };

  it('lists the most recent conversation first and no salon', () => {
    const out = reelSendCandidates({ ...base, conversations: rows, query: '' });
    expect(out.map((c) => c.key)).toEqual(['g-new', 'g-old']);
  });

  it('searches locally on the name', () => {
    const out = reelSendCandidates({ ...base, conversations: rows, query: 'old' });
    expect(out.map((c) => c.key)).toEqual(['g-old']);
  });
});

describe('toggleReelTarget', () => {
  it('ticks, then unticks', () => {
    const on = toggleReelTarget([], 'a', 2);
    expect(on).toEqual({ selected: ['a'], capped: false });
    expect(toggleReelTarget(on.selected, 'a', 2)).toEqual({ selected: [], capped: false });
  });

  it('refuses a tick past the cap with capped, and keeps the selection as it was', () => {
    expect(toggleReelTarget(['a', 'b'], 'c', 2)).toEqual({ selected: ['a', 'b'], capped: true });
  });

  it('always allows an untick, even at the cap', () => {
    expect(toggleReelTarget(['a', 'b'], 'a', 2)).toEqual({ selected: ['b'], capped: false });
  });
});

describe('reelSendPlan', () => {
  it('names the four outcomes of one press', () => {
    expect(reelSendPlan(false, 0)).toBe('none');
    expect(reelSendPlan(true, 0)).toBe('feed');
    expect(reelSendPlan(false, 3)).toBe('chats');
    expect(reelSendPlan(true, 3)).toBe('both');
  });
});

describe('reelSendFailedName (15.2, reel_sendto_failed_in)', () => {
  const rows = [convo({ id: 'g1', name: 'Bureau' }), convo({ id: 'g2', name: 'Copains' })];

  it("names the group the send failed in, found by its MLS id, not by the map's key", () => {
    expect(reelSendFailedName([['some-key', rows[1][1]]], 'g2', ME)).toBe('Copains');
  });

  it('names nothing for a conversation this device no longer holds - never a raw id', () => {
    expect(reelSendFailedName(rows, 'gone', ME)).toBeNull();
  });
});

describe('reelSendFailedNotice (15.2): ONE notice per cause', () => {
  const rows = [convo({ id: 'g1', name: 'Bureau' }), convo({ id: 'g2', name: 'Copains' })];

  it('names the conversation of a send refused on its own', () => {
    expect(reelSendFailedNotice(rows, { kind: 'send', conversationId: 'g1' }, ME)).toEqual({
      text: m.reel_sendto_failed_in({ name: 'Bureau' }),
      form: 'named',
    });
  });

  it("says a take's verdict once, with how many conversations it reached", () => {
    expect(
      reelSendFailedNotice(rows, { kind: 'take', conversationIds: ['g1', 'g2', 'g3'] }, ME)
    ).toEqual({ text: m.reel_sendto_failed_in_many({ count: 3 }), form: 'count' });
    expect(reelSendFailedNotice(rows, { kind: 'take', conversationIds: ['g2'] }, ME).form).toBe(
      'named'
    );
  });

  it('never names a raw id: a conversation gone, or a take whose sends are no longer known', () => {
    expect(reelSendFailedNotice(rows, { kind: 'send', conversationId: 'gone' }, ME).form).toBe(
      'unnamed'
    );
    expect(reelSendFailedNotice(rows, { kind: 'take', conversationIds: [] }, ME)).toEqual({
      text: m.reel_sendto_failed_in_chosen(),
      form: 'unknown',
    });
  });
});

describe('reelSendSections (owner, 2026-11-16): Recents, then the rest alphabetically', () => {
  const cands = (names: string[]) =>
    reelSendCandidates({
      conversations: names.map((name, i) =>
        convo({ id: `g-${name}`, name, lastMessageAt: 100 - i })
      ),
      currentUserId: ME,
      peerNames: {},
      query: '',
      blockedPeerIds: new Set(),
    });

  it('puts the latest conversations under "Recents" and every other one alphabetically after', () => {
    const names = ['Zulu', 'Yankee', 'Xray', 'Whiskey', 'Victor', 'Uniform', 'Mike', 'Bravo'];
    const sections = reelSendSections(cands(names), '');
    expect(sections.map((s) => s.title)).toEqual([
      m.reel_sendto_section_recent(),
      m.reel_sendto_section_all(),
    ]);
    expect(sections[0].rows.map((r) => r.label)).toEqual(names.slice(0, REEL_SEND_RECENT_COUNT));
    expect(sections[1].rows.map((r) => r.label)).toEqual(['Bravo', 'Mike']);
  });

  it('draws no empty section: a short list is "Recents" alone', () => {
    const sections = reelSendSections(cands(['Alpha', 'Bravo']), '');
    expect(sections.map((s) => s.id)).toEqual(['recent']);
  });

  it('a search is one untitled list, alphabetical', () => {
    const sections = reelSendSections(cands(['Zulu', 'Alpha', 'Mike']), 'u');
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBeNull();
    expect(sections[0].rows.map((r) => r.label)).toEqual(['Alpha', 'Mike', 'Zulu']);
  });
});

describe('reelSendKeyOf: the conversation a camera came from, by its id', () => {
  it('finds the map key of the conversation, and null for one this device does not hold', () => {
    const rows = [
      convo({ id: 'g-1', name: 'One' }),
      ['dm-key', { ...convo({ id: 'd-1', name: 'Dee' })[1] }],
    ] as [string, Conversation][];
    expect(reelSendKeyOf(rows, 'd-1')).toBe('dm-key');
    expect(reelSendKeyOf(rows, 'gone')).toBeNull();
  });
});

describe('userIdsOfIdentities: a group subtitle names each member once', () => {
  it('splits userId:deviceId leaves, keeps tree order, dedupes a member with two devices', () => {
    expect(userIdsOfIdentities(['a:web-1', 'b:tauri-2', 'a:tauri-3'])).toEqual(['a', 'b']);
  });

  it('skips a leaf that is not an identity, said at warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(userIdsOfIdentities(['nocolon', 'b:web-1'])).toEqual(['b']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('readGroupMembersOnceReady: one batch, once MLS is ready, never one line per group', () => {
  it('asks no tree before MLS is ready, then reads every group of the batch', async () => {
    let ready!: () => void;
    const readTree = vi.fn(async (id: string) => [`${id}-u:web-1`]);
    const pending = readGroupMembersOnceReady(['g-1', 'g-2'], {
      whenReady: () => new Promise<void>((resolve) => (ready = resolve)),
      readTree,
    });
    await Promise.resolve();
    expect(readTree).not.toHaveBeenCalled();
    ready();
    const members = await pending;
    expect([...members]).toEqual([
      ['g-1', ['g-1-u']],
      ['g-2', ['g-2-u']],
    ]);
  });

  it('a session that ends before MLS is ready reads nothing and warns nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const readTree = vi.fn(async () => []);
    const members = await readGroupMembersOnceReady(['g-1', 'g-2', 'g-3'], {
      whenReady: async () => {
        throw new Error('signed out');
      },
      readTree,
    });
    expect(members.size).toBe(0);
    expect(readTree).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    debug.mockRestore();
  });

  it('groups with no tree here are left out and said in ONE warn line for the batch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const members = await readGroupMembersOnceReady(['g-1', 'g-2', 'g-3'], {
      whenReady: async () => {},
      readTree: async (id) => {
        if (id !== 'g-2') throw new Error('not held');
        return ['a:web-1'];
      },
    });
    expect([...members.keys()]).toEqual(['g-2']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('2 of 3');
    warn.mockRestore();
  });
});
