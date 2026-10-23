import { describe, it, expect } from 'vitest';
import type { Conversation } from '$lib/types';
import { resolveCallPeers } from './callPeers';

const convo = (over: Partial<Conversation>): Conversation =>
  ({ id: 'g', name: 'n', contactName: '', messages: [], ...over }) as unknown as Conversation;

const dmWithBob = convo({
  id: 'group-bob',
  name: 'Bob',
  contactName: 'bob@example.org',
  conversationType: 'direct',
  directPeerId: 'bob@example.org',
});
const dmWithCarol = convo({
  id: 'group-carol',
  name: 'Carol',
  contactName: 'carol@example.org',
  conversationType: 'direct',
  directPeerId: 'carol@example.org',
});

const nameOf = (id: string) => `name:${id}`;

describe('resolveCallPeers', () => {
  it("names the CALL's conversation peer, whichever conversation the list holds first", () => {
    const peers = resolveCallPeers({
      userId: 'me@example.org',
      callGroupId: 'group-bob',
      conversations: [dmWithCarol, dmWithBob],
      incomingCallerId: null,
      nameOf,
    });
    expect(peers.map((p) => p.userId)).toEqual(['bob@example.org']);
  });

  it('falls to the caller we were rung by when the conversation is not on this device', () => {
    const peers = resolveCallPeers({
      userId: 'me@example.org',
      callGroupId: 'group-unknown',
      conversations: [dmWithCarol],
      incomingCallerId: 'Dave@Example.org',
      nameOf,
    });
    expect(peers).toEqual([{ userId: 'dave@example.org', displayName: 'name:dave@example.org' }]);
  });

  it('names nobody rather than ourselves', () => {
    expect(
      resolveCallPeers({
        userId: 'me@example.org',
        callGroupId: null,
        conversations: [],
        incomingCallerId: 'ME@example.org',
        nameOf,
      })
    ).toEqual([]);
  });
});
