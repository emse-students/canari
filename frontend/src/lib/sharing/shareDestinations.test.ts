import { describe, expect, it } from 'vitest';
import type { Conversation } from '$lib/types';
import { missingPeerNameIds, shareCandidates } from './shareDestinations';

/**
 * One list of destinations for both pickers: the "Envoyer a..." picker searches it alphabetically,
 * a post's share sheet opens it on the most recent conversations (Instagram's grid). Neither may
 * show a raw id, and a salon is told apart by its community.
 */
const ME = '11111111-1111-4111-8111-111111111111';
const SALON = 'channel_22222222-2222-4222-8222-222222222222';

function convo(id: string, name: string, at: number, extra: Partial<Conversation> = {}) {
  const c = {
    id,
    name,
    contactName: name,
    messages: [],
    lifecycle: 'active',
    mlsStateHex: null,
    conversationType: 'group',
    lastMessageAt: at,
    ...extra,
  } as Conversation;
  return [id, c] as [string, Conversation];
}

const LIST = [
  convo('g-a', 'Alpha', 1000),
  convo('g-z', 'Zeta', 3000),
  convo(SALON, 'General', 2000, { conversationType: 'channel' }),
];
const WORKSPACES = [{ name: 'BDE', channels: [{ id: SALON }] }];

function labels(order: 'alphabetical' | 'recent', query = '', preselectedId?: string) {
  return shareCandidates({
    conversations: LIST,
    currentUserId: ME,
    workspaces: WORKSPACES,
    peerNames: {},
    query,
    order,
    preselectedId,
  }).map((c) => c.label);
}

describe('shareCandidates', () => {
  it('orders the share sheet by recency, newest first', () => {
    expect(labels('recent')).toEqual(['Zeta', 'General', 'Alpha']);
  });

  it('orders the forward picker by community, then by name', () => {
    expect(labels('alphabetical')).toEqual(['Alpha', 'Zeta', 'General']);
  });

  it('puts the preselected conversation first whatever the order', () => {
    expect(labels('recent', '', 'g-a')[0]).toBe('Alpha');
    expect(labels('alphabetical', '', SALON)[0]).toBe('General');
  });

  it('searches the name and the community, and names a salon by its community', () => {
    expect(labels('recent', 'bde')).toEqual(['General']);
    const [salon] = shareCandidates({
      conversations: LIST,
      currentUserId: ME,
      workspaces: WORKSPACES,
      peerNames: {},
      query: 'gen',
      order: 'recent',
    });
    expect(salon.community).toBe('BDE');
  });

  it('leaves out the excluded conversation (the one a message is forwarded from)', () => {
    const keys = shareCandidates({
      conversations: LIST,
      currentUserId: ME,
      workspaces: WORKSPACES,
      peerNames: {},
      query: '',
      order: 'recent',
      excludeKey: 'g-z',
    }).map((c) => c.key);
    expect(keys).not.toContain('g-z');
  });
});

describe('missingPeerNameIds', () => {
  it('names no group and no salon - only a DM peer can be unknown', () => {
    expect(missingPeerNameIds(LIST, ME)).toEqual([]);
  });
});
