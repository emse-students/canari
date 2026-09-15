/**
 * WHOSE NAME IS ON THE ROW A PUSH CREATES, AND WHO CORRECTS IT LATER.
 *
 * Measured 2026-09-08 on a two-person group: seven hours after it was deleted, the phone's sidebar
 * still carried it as the SECOND row titled with the other member's name, directly above the real
 * DM with that same person and titled identically. Two rows, one name, nothing on either to say
 * which was the conversation.
 *
 * It was two defects stacked, and either alone would have been invisible:
 *
 * 1. The push cache labelled the placeholder row with the SENDER. For a DM that is right by
 *    accident - the sender IS the conversation - and for a group it is the first person to speak.
 *    The push had carried the group's real name the whole time (`buildPushDataFields.groupName`);
 *    the two native writers simply did not copy it into the cache file.
 * 2. Nothing ever corrected a group's name afterwards. The comment beside the write said the
 *    Welcome would overwrite it, and no Welcome is coming for a group this device is already in.
 *    `ensureConversationForServerGroup` holds the server's name on every discovery sweep and
 *    returned `existed` without looking at it.
 *
 * So both halves are pinned here. The label test is the cause; the repair test is the reason the
 * cause was permanent, and it is the one that also covers a rename missed while the app was closed.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Conversation } from '$lib/types';
import { placeholderNameForPushEntry } from './fcmCache';
import { ensureConversationForServerGroup, type ServerGroupRow } from './serverGroupConversation';

describe('placeholderNameForPushEntry', () => {
  it('names a group after the GROUP, not after whoever messaged first', () => {
    expect(
      placeholderNameForPushEntry({
        groupId: 'aaaaaaaa-bbbb',
        senderName: 'Canari Test Beta',
        groupName: 'Les ROOTz',
      })
    ).toBe('Les ROOTz');
  });

  /**
   * The server sends an empty `groupName` for a DM, deliberately, and there the sender IS the
   * conversation - this is the first-contact P1 of 2026-09-08 and it must keep working.
   */
  it('still names a DM after the sender, because for a DM they are the same person', () => {
    expect(
      placeholderNameForPushEntry({
        groupId: 'aaaaaaaa-bbbb',
        senderName: 'Canari Test Beta',
        groupName: '',
      })
    ).toBe('Canari Test Beta');
  });

  /**
   * The cache is a file on disk that outlives an app update, so an entry queued by a build older
   * than this change has no `groupName` key at all. It must behave exactly as it did before rather
   * than throw or blank the row.
   */
  it('falls back to the sender for an entry written by an older native build', () => {
    expect(
      placeholderNameForPushEntry({ groupId: 'aaaaaaaa-bbbb', senderName: 'Canari Test Beta' })
    ).toBe('Canari Test Beta');
  });

  /**
   * The group id is not a name and is not meant to read as one: `isRawId` recognises it and the
   * sidebar renders "Groupe". Saying nothing beats inventing something.
   */
  it('says nothing when the push carried neither name', () => {
    expect(placeholderNameForPushEntry({ groupId: 'aaaaaaaa-bbbb', senderName: '' })).toBe(
      'aaaaaaaa-bbbb'
    );
  });

  it('ignores whitespace-only names on both sides', () => {
    expect(
      placeholderNameForPushEntry({ groupId: 'g1', senderName: 'Beta', groupName: '   ' })
    ).toBe('Beta');
    expect(placeholderNameForPushEntry({ groupId: 'g1', senderName: '  ', groupName: '' })).toBe(
      'g1'
    );
  });
});

describe('ensureConversationForServerGroup - the label of a row that already exists', () => {
  const GROUP_ID = 'e615e00a-2c4d-443a-a940-2ac33303647a';

  const row = (over: Partial<Conversation> = {}): Conversation =>
    ({
      id: GROUP_ID,
      name: 'Canari Test Beta',
      contactName: 'Canari Test Beta',
      messages: [],
      lifecycle: 'active',
      mlsStateHex: null,
      unreadCount: 0,
      conversationType: 'group',
      ...over,
    }) as Conversation;

  const deps = (conversations: Map<string, Conversation>, saveConversation = vi.fn()) => ({
    // Nothing below the early return is reached in these cases, so the MLS service is never asked
    // anything: a stub that THROWS is the assertion that it is not.
    mlsService: new Proxy(
      {},
      {
        get() {
          throw new Error('the MLS service must not be consulted for a group already known');
        },
      }
    ) as never,
    userId: 'u-self',
    conversations,
    saveConversation,
    owedExits: new Set<string>(),
    log: vi.fn(),
  });

  const group = (over: Partial<ServerGroupRow> = {}): ServerGroupRow => ({
    groupId: GROUP_ID,
    name: 'N17B-mtsi0qrfu86',
    isGroup: true,
    ...over,
  });

  it('relabels a group the server names differently, and persists it', async () => {
    const conversations = new Map([[GROUP_ID, row()]]);
    const saveConversation = vi.fn().mockResolvedValue(undefined);
    const d = deps(conversations, saveConversation);

    expect(await ensureConversationForServerGroup(group(), d)).toBe('existed');

    expect(conversations.get(GROUP_ID)?.name).toBe('N17B-mtsi0qrfu86');
    expect(conversations.get(GROUP_ID)?.contactName).toBe('N17B-mtsi0qrfu86');
    expect(saveConversation).toHaveBeenCalledWith(GROUP_ID);
    // A label changing under someone who is looking at it is not allowed to be silent.
    expect(d.log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('relabelled');
  });

  it('writes nothing when the two names already agree', async () => {
    const conversations = new Map([[GROUP_ID, row({ name: 'N17B-mtsi0qrfu86' })]]);
    const saveConversation = vi.fn();
    const d = deps(conversations, saveConversation);

    expect(await ensureConversationForServerGroup(group(), d)).toBe('existed');

    expect(saveConversation).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });

  /**
   * THE CONTROL, and the reason the repair is gated on `isGroup` rather than on "the names differ".
   * A DM's server name is the canonical `self::peer` KEY; its row's name is the peer's resolved
   * display name. They differ by design, and overwriting one with the other would put a pair of
   * uuids in the sidebar where a person's name belongs.
   */
  it('leaves a DM alone, whose server name is a key and not a label', async () => {
    const conversations = new Map([
      [GROUP_ID, row({ conversationType: 'direct', name: 'Canari Test Beta' })],
    ]);
    const saveConversation = vi.fn();
    const d = deps(conversations, saveConversation);

    expect(
      await ensureConversationForServerGroup(group({ isGroup: false, name: 'u-self::u-peer' }), d)
    ).toBe('existed');

    expect(conversations.get(GROUP_ID)?.name).toBe('Canari Test Beta');
    expect(saveConversation).not.toHaveBeenCalled();
  });

  /**
   * An absent answer is not a negative answer: a server row carrying no name says the request told
   * us nothing about the label, not that the group has none.
   */
  it('leaves the row alone when the server row carries no name', async () => {
    const conversations = new Map([[GROUP_ID, row()]]);
    const saveConversation = vi.fn();
    const d = deps(conversations, saveConversation);

    expect(await ensureConversationForServerGroup(group({ name: null }), d)).toBe('existed');
    expect(conversations.get(GROUP_ID)?.name).toBe('Canari Test Beta');
    expect(saveConversation).not.toHaveBeenCalled();
  });

  /**
   * The row for a DM is keyed by the PEER'S user id, not by the group id - the reason the lookup
   * scans values rather than asking `conversations.has`. The repair has to write back under that
   * same key, so a group row keyed by anything else must still be found and still be repaired.
   */
  it('repairs a row held under a key that is not the group id', async () => {
    const conversations = new Map([['some-other-key', row()]]);
    const saveConversation = vi.fn().mockResolvedValue(undefined);

    expect(
      await ensureConversationForServerGroup(group(), deps(conversations, saveConversation))
    ).toBe('existed');

    expect(conversations.get('some-other-key')?.name).toBe('N17B-mtsi0qrfu86');
    expect(conversations.has(GROUP_ID)).toBe(false);
    expect(saveConversation).toHaveBeenCalledWith('some-other-key');
  });
});
