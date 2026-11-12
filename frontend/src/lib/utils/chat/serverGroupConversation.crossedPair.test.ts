/**
 * Discovery and a crossed 1:1 pair: the SURVIVOR is never the one ignored.
 *
 * Discovery used to ignore any second DM group for a peer already loaded, whichever came first. A
 * device that had only the loser's row (a partial re-join, a second device whose Welcome to the
 * survivor was owed) therefore never created the survivor's row, never joined it, and the boot merge
 * - which keeps the lowest group id on every device - could never fold the pair together. Now
 * discovery ignores only a group that ranks AFTER the one loaded.
 */
import type { Conversation } from '$lib/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import { ensureConversationForServerGroup, type ServerGroupRow } from './serverGroupConversation';

const ME = 'a11ce000-0000-4000-8000-000000000000';
const PEER = 'b0b00000-0000-4000-8000-000000000000';
const LOW = '10000000-0000-4000-8000-00000000000a';
const HIGH = 'f0000000-0000-4000-8000-00000000000b';

function loadedDm(id: string): Map<string, Conversation> {
  return new Map([
    [
      id,
      {
        id,
        name: `${ME}::${PEER}`,
        contactName: PEER,
        directPeerId: PEER,
        conversationType: 'direct',
        messages: [],
        lifecycle: 'active',
        mlsStateHex: null,
      } as unknown as Conversation,
    ],
  ]);
}

async function discover(conversations: Map<string, Conversation>, groupId: string) {
  const log = vi.fn();
  const group: ServerGroupRow = { groupId, name: `${ME}::${PEER}`, isGroup: false };
  const outcome = await ensureConversationForServerGroup(group, {
    mlsService: {
      getLocalGroups: () => [],
      notifyConversationAvailable: vi.fn(),
    } as unknown as IMlsService,
    userId: ME,
    conversations,
    saveConversation: vi.fn(async () => {}),
    owedExits: new Set<string>(),
    log,
  });
  return { outcome, log };
}

describe('discovery of a second DM group for a peer already loaded', () => {
  it('creates the row of the SURVIVOR (lower id) when the loser was loaded first', async () => {
    const conversations = loadedDm(HIGH);
    const { outcome } = await discover(conversations, LOW);
    expect(outcome).toBe('created');
    expect(conversations.get(LOW)?.lifecycle).toBe('pending');
    // The loser stays: the boot merge folds it once this device holds the survivor.
    expect(conversations.has(HIGH)).toBe(true);
  });

  it('still ignores the LOSER (higher id) when the survivor is loaded', async () => {
    const conversations = loadedDm(LOW);
    const { outcome } = await discover(conversations, HIGH);
    expect(outcome).toBe('duplicate');
    expect(conversations.has(HIGH)).toBe(false);
  });
});
