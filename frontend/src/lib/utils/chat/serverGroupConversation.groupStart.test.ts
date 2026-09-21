/**
 * When a conversation BEGAN, and why the client cannot work it out for itself.
 *
 * The scrollback reaches BELOW this device's retention window by asking a member who kept more. A
 * group created INSIDE that window has nothing below it - but the messages alone can never say so,
 * because the oldest message a device holds is always strictly AFTER the group was created. So a
 * first contact and a device missing years of history are the same shape, and the first contact
 * asked, found nobody online to answer (the only other member being the person who had just
 * written), and told the reader no device could supply older messages.
 *
 * The group's creation instant is the fact that separates them. It comes from the server, it never
 * moves, and these tests pin the two things that make it usable: that an unusable value reads as
 * UNKNOWN rather than as zero, and that a row stored before this shipped is repaired rather than
 * left asking for ever.
 */
import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import {
  ensureConversationForServerGroup,
  groupStartInstant,
  type ServerGroupRow,
} from './serverGroupConversation';

const GROUP_ID = 'e4c1f0aa-0000-4000-8000-000000000001';
const CREATED_ISO = '2026-09-21T00:00:00.000Z';
const CREATED_MS = Date.parse(CREATED_ISO);

/** A row already in the map for {@link GROUP_ID}, so the `existed` path is the one exercised. */
function held(over: Partial<Conversation> = {}): Map<string, Conversation> {
  return new Map([
    [
      GROUP_ID,
      {
        id: GROUP_ID,
        name: 'Amis',
        contactName: 'Amis',
        messages: [],
        lifecycle: 'active',
        mlsStateHex: null,
        conversationType: 'group',
        ...over,
      } as unknown as Conversation,
    ],
  ]);
}

function serverRow(over: Partial<ServerGroupRow> = {}): ServerGroupRow {
  return { groupId: GROUP_ID, name: 'Amis', isGroup: true, createdAt: CREATED_ISO, ...over };
}

async function sweep(conversations: Map<string, Conversation>, group: ServerGroupRow) {
  const saveConversation = vi.fn(async () => {});
  const outcome = await ensureConversationForServerGroup(group, {
    mlsService: {} as unknown as IMlsService,
    userId: 'u1',
    conversations,
    saveConversation,
    owedExits: new Set<string>(),
    log: vi.fn(),
  });
  return { outcome, saveConversation };
}

describe('groupStartInstant', () => {
  it('reads the instant the server sent', () => {
    expect(groupStartInstant({ createdAt: CREATED_ISO })).toBe(CREATED_MS);
  });

  it('answers UNDEFINED for anything unusable, which is what makes the caller ask', () => {
    // Undefined must not collapse onto 0. A zero would be below every window, so it would read as
    // "this group is older than anything you retain" - the exact opposite of "I do not know", and
    // it would suppress nothing while looking like a decision.
    //
    // NOT EVERY ABSURD STRING IS CAUGHT, AND IT DOES NOT HAVE TO BE: `Date.parse('0')` answers the
    // year 2000, which is below every window and therefore ASKS - the same thing `undefined` does.
    // What this guards is the direction, not the grammar of a date the server generates from a
    // timestamp column.
    for (const createdAt of [undefined, null, '', '   ', 'not-a-date']) {
      expect(groupStartInstant({ createdAt } as Pick<ServerGroupRow, 'createdAt'>)).toBeUndefined();
    }
  });
});

describe('the group start reaches a row that already exists', () => {
  it('writes it onto a row stored before this shipped, and persists it', async () => {
    // WITHOUT THIS THE FIX WOULD REACH ONLY NEW CONVERSATIONS. A device does not re-create rows it
    // already holds, so every conversation that existed before would ask for an impossible past for
    // ever. This sweep visits every active group on every connection, which makes it the one pass
    // that reaches them all.
    const conversations = held();
    const { outcome, saveConversation } = await sweep(conversations, serverRow());

    expect(outcome).toBe('existed');
    expect(conversations.get(GROUP_ID)?.startedAt).toBe(CREATED_MS);
    expect(saveConversation).toHaveBeenCalledWith(GROUP_ID);
  });

  it('leaves a row that already carries one alone, and writes nothing', async () => {
    // The value is a fixed fact about the group's row, so this is write-once. A save on every group
    // on every connection would be a write nobody needs and a line nobody reads.
    const conversations = held({ startedAt: CREATED_MS });
    const { saveConversation } = await sweep(conversations, serverRow());

    expect(conversations.get(GROUP_ID)?.startedAt).toBe(CREATED_MS);
    expect(saveConversation).not.toHaveBeenCalled();
  });

  it('leaves the row untouched when the server said nothing usable', async () => {
    const conversations = held();
    const { saveConversation } = await sweep(conversations, serverRow({ createdAt: null }));

    expect(conversations.get(GROUP_ID)?.startedAt).toBeUndefined();
    expect(saveConversation).not.toHaveBeenCalled();
  });

  it('does not undo the RELABEL that runs just before it', async () => {
    // TWO REPAIRS OVER ONE ROW. The relabel replaces the row; a second repair spreading the copy it
    // held from the top of the pass would put the old name straight back, and the group would be
    // renamed and un-renamed on every connection for ever. Both must survive one pass.
    const conversations = held({ name: 'Ancien nom', contactName: 'Ancien nom' });
    await sweep(conversations, serverRow({ name: 'Nouveau nom' }));

    const row = conversations.get(GROUP_ID);
    expect(row?.name).toBe('Nouveau nom');
    expect(row?.startedAt).toBe(CREATED_MS);
  });
});
