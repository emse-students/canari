/**
 * An unnamed group is drawn by its members' first names on every surface that names a conversation
 * - the list and its search, the header, a notification, the share sheet - because all of them read
 * `resolveConversationListPresentation` (docs/wiki/frontend/modules/chat.md#one-new-discussion-panel).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The label asks each member's profile once; the names here are seeded, so nothing is fetched.
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveUserDisplayName: async () => null,
}));
import { m } from '$lib/paraglide/messages';
import { resolveConversationListPresentation } from './conversations';
import { bindGroupTreeReader, refreshGroupTreeMembers } from './groupTreeMembers';
import { seedUserDisplayName } from '$lib/utils/users/displayName';

const GROUP = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

afterEach(() => bindGroupTreeReader(null));

const present = (name: string) =>
  resolveConversationListPresentation(
    { id: GROUP, name, contactName: GROUP, conversationType: 'group' },
    'me'
  ).displayName;

describe('an unnamed group', () => {
  it('reads "Groupe" until its tree is read, then its members by first name', async () => {
    seedUserDisplayName('alice', 'Alice Martin', 'Alice');
    seedUserDisplayName('bob', 'Bob Durand', 'Bob');
    bindGroupTreeReader(async () => ['me:d1', 'alice:d1', 'bob:d1']);

    expect(present('')).toBe(m.conversation_unnamed_group());
    await refreshGroupTreeMembers(GROUP, 'test');

    expect(present('')).toBe(m.group_default_name_two({ first: 'Alice', second: 'Bob' }));
    // A row that only knows its id, as a newcomer's placeholder does, is unnamed too.
    expect(present(GROUP)).toBe(m.group_default_name_two({ first: 'Alice', second: 'Bob' }));
  });

  it('never covers a name the group was given', async () => {
    bindGroupTreeReader(async () => ['me:d1', 'alice:d1']);
    await refreshGroupTreeMembers(GROUP, 'test');
    expect(present('Projet Canari')).toBe('Projet Canari');
  });

  it('keeps "Groupe" when the viewer is alone in it', async () => {
    bindGroupTreeReader(async () => ['me:d1', 'me:d2']);
    await refreshGroupTreeMembers(GROUP, 'test');
    expect(present('')).toBe(m.conversation_unnamed_group());
  });
});
