import { describe, expect, it } from 'vitest';
import type { Conversation } from '$lib/types';
import {
  isReelSendListed,
  reelSendCandidates,
  reelSendPlan,
  toggleReelTarget,
} from './reelSendTargets';

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
