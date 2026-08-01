import type { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import { resolveConversationKey } from './openConversationFromId';

/**
 * A conversations map shaped like the real one: DMs and groups are keyed by DISPLAY NAME and carry
 * the MLS group id in `id`, community channels are keyed by the very id they carry. That asymmetry
 * is the whole point of the resolver.
 */
function mapOf(entries: [string, string][]): SvelteMap<string, Conversation> {
  return new Map(entries.map(([key, id]) => [key, { id } as Conversation])) as unknown as SvelteMap<
    string,
    Conversation
  >;
}

const GROUP_ID = '5f4d0010-1234-4000-8000-000000000000';
const CHANNEL = 'channel_ee943652-f5d0-4550-b74b-b781f8c4d84b';

describe('resolveConversationKey', () => {
  it('resolves the group id a notification carries to the DM display name it is keyed by', () => {
    // The tapped notification names the MLS group id; the map knows that conversation as "Alice".
    // Every landing comparison crosses this gap, and comparing the two raw strings is what made a
    // DM deep link end its own landing and settle on the right tab with nothing selected.
    expect(resolveConversationKey(mapOf([['Alice', GROUP_ID]]), GROUP_ID)).toBe('Alice');
  });

  it('resolves a channel target to itself', () => {
    // A channel is keyed by its conversation id, so key and target are the same string - which is
    // exactly why the raw comparison worked for channels and for nothing else.
    expect(resolveConversationKey(mapOf([[CHANNEL, CHANNEL]]), CHANNEL)).toBe(CHANNEL);
  });

  it('prefers a direct key hit over the name scan', () => {
    expect(
      resolveConversationKey(
        mapOf([
          [GROUP_ID, 'other-group'],
          ['Alice', GROUP_ID],
        ]),
        GROUP_ID
      )
    ).toBe(GROUP_ID);
  });

  it('returns null for a conversation this device does not have', () => {
    // The landing reads this as "not here yet" and holds, rather than selecting nothing.
    expect(resolveConversationKey(mapOf([['Alice', GROUP_ID]]), 'unknown-group')).toBeNull();
  });

  it('treats an empty target as nothing to resolve', () => {
    expect(resolveConversationKey(mapOf([['Alice', GROUP_ID]]), null)).toBeNull();
    expect(resolveConversationKey(mapOf([['Alice', GROUP_ID]]), '')).toBeNull();
  });
});
