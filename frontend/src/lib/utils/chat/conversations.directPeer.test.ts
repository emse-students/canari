import {
  resolveDirectPeerId,
  canonicalDirectName,
  findDirectConversationByPeer,
} from './conversations';
import type { Conversation } from '$lib/types';

const ME = 'd82cd226d82cd226d82cd226d82cd226d82cd226d82cd226d82cd226d82cd226';
const PEER = '40bb4eab40bb4eab40bb4eab40bb4eab40bb4eab40bb4eab40bb4eab40bb4eab';
const GROUP = 'f21e2964-5c0c-48d5-8d66-7500d0c71685';

function mockMls(members: { userId: string }[] | Error) {
  return {
    getGroupUserMembers: vi.fn(async () => {
      if (members instanceof Error) throw members;
      return members;
    }),
  };
}

describe('canonicalDirectName', () => {
  it('formats self::peer lowercased', () => {
    expect(canonicalDirectName(ME.toUpperCase(), PEER)).toBe(`${ME}::${PEER}`);
  });
});

describe('resolveDirectPeerId', () => {
  it('uses the name when it encodes a valid peer (no roster call)', async () => {
    const mls = mockMls([{ userId: ME }, { userId: PEER }]);
    const peer = await resolveDirectPeerId(mls, GROUP, `${ME}::${PEER}`, ME);
    expect(peer).toBe(PEER);
    expect(mls.getGroupUserMembers).not.toHaveBeenCalled();
  });

  it('falls back to the roster when the name is self-only (the production bug)', async () => {
    const mls = mockMls([{ userId: ME }, { userId: PEER }]);
    // Malformed group name: the user's own id alone, no "::peer".
    const peer = await resolveDirectPeerId(mls, GROUP, ME, ME);
    expect(peer).toBe(PEER);
    expect(mls.getGroupUserMembers).toHaveBeenCalledWith(GROUP);
  });

  it('falls back to the roster when the name is self::self', async () => {
    const mls = mockMls([{ userId: ME }, { userId: PEER }]);
    const peer = await resolveDirectPeerId(mls, GROUP, `${ME}::${ME}`, ME);
    expect(peer).toBe(PEER);
  });

  it('returns null (never self) when the roster is transiently self-only', async () => {
    const mls = mockMls([{ userId: ME }]);
    const peer = await resolveDirectPeerId(mls, GROUP, ME, ME);
    expect(peer).toBeNull();
  });

  it('returns null on roster transport failure rather than inventing a peer', async () => {
    const mls = mockMls(new Error('network down'));
    const peer = await resolveDirectPeerId(mls, GROUP, '', ME);
    expect(peer).toBeNull();
  });
});

describe('findDirectConversationByPeer', () => {
  function dm(id: string, lifecycle: Conversation['lifecycle']): Conversation {
    return {
      id,
      name: id,
      contactName: PEER,
      directPeerId: PEER,
      conversationType: 'direct',
      messages: [],
      lifecycle,
      mlsStateHex: null,
    } as Conversation;
  }

  it('finds the live DM with the peer, whatever the case of the id asked', () => {
    const map = new Map([['g-live', dm('g-live', 'active')]]);
    expect(findDirectConversationByPeer(map, PEER.toUpperCase())?.[0]).toBe('g-live');
  });

  // A TOMBSTONE IS NOT A CANDIDATE (owner, 2026-11-10): a DM the peer deleted is never adopted by
  // the next one - the rule the startup merge already applied (`canRepresentThePeer`).
  it('never answers a retired DM, even when it is the only one', () => {
    const map = new Map([['g-old', dm('g-old', 'removed')]]);
    expect(findDirectConversationByPeer(map, PEER)).toBeUndefined();
  });

  it('skips a retired DM listed before the live one', () => {
    const map = new Map([
      ['g-old', dm('g-old', 'removed')],
      ['g-live', dm('g-live', 'pending')],
    ]);
    expect(findDirectConversationByPeer(map, PEER)?.[0]).toBe('g-live');
  });
});
