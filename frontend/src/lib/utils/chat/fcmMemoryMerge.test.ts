/**
 * A FIRST MESSAGE FROM SOMEONE YOU HAVE NO CONVERSATION WITH MUST BECOME A CONVERSATION.
 *
 * Reported from production by the user on 2026-09-08: someone messages you for the first time, the
 * notification arrives with the text decrypted, and then tapping it lands nowhere and the
 * conversation is simply absent - until the app is restarted, after which both are there.
 *
 * The cause was one line. `consumeFcmCache` writes BOTH halves to storage - the message and a
 * placeholder conversation row for the group that was joined in the background - and says so:
 * `[FCM_CACHE] Injection done: 1/1 message(s) injected`. `mergeFcmMessagesIntoConversations` then
 * did `conversations.get(id)` and `continue`, so the in-memory list, which is what the UI renders
 * and what a deep link resolves against, never learned about either. A restart read the placeholder
 * back from the database, which is why the workaround looked like a refresh problem.
 *
 * **NEITHER FILE HAD A TEST**, which is the other half of why it survived: the only assertion
 * anywhere near this path was a log line saying the injection had succeeded, and it had - into the
 * store nobody was looking at.
 *
 * The cases below are the three states a message can arrive in, and the middle one is the defect.
 */
import { describe, it, expect, vi } from 'vitest';
import type { StoredMessage } from '$lib/db/types';
import type { Conversation } from '$lib/types';
import { mergeFcmMessagesIntoConversations } from './fcmMemoryMerge';

/** A cached message as `consumeFcmCache` hands it over, with a real serialized envelope. */
const message = (over: Partial<StoredMessage> = {}): StoredMessage => ({
  id: 'msg-0000-1111',
  conversationId: 'grp-aaaa-bbbb',
  senderId: 'sender-1',
  content: JSON.stringify({ type: 'text', content: 'bonjour' }),
  timestamp: 1_700_000_000_000,
  isFcmPreview: true,
  ...over,
});

/** An ordinary conversation already on screen. */
const existing = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'grp-aaaa-bbbb',
  name: 'Someone',
  contactName: 'Someone',
  messages: [],
  lifecycle: 'active',
  mlsStateHex: null,
  ...over,
});

/** What `consumeFcmCache` returns beside the messages - the label it actually wrote to the DB. */
const placeholders = (name = 'Alice') =>
  new Map([['grp-aaaa-bbbb', { name, updatedAt: 1_700_000_000_000 }]]);

describe('mergeFcmMessagesIntoConversations', () => {
  it('adds the message to a conversation that is already in memory', () => {
    const convs = new Map([['grp-aaaa-bbbb', existing()]]);

    expect(mergeFcmMessagesIntoConversations([message()], convs, 'me')).toBe(1);
    expect(convs.get('grp-aaaa-bbbb')?.messages).toHaveLength(1);
    // Untouched: this conversation has a real name and a real lifecycle, and a cached preview is
    // not evidence about either.
    expect(convs.get('grp-aaaa-bbbb')?.lifecycle).toBe('active');
    expect(convs.get('grp-aaaa-bbbb')?.name).toBe('Someone');
  });

  /**
   * THE DEFECT, AS THE USER MET IT. No conversation in memory, a placeholder in hand.
   *
   * The assertion is that the conversation EXISTS afterwards, because that is what the report is
   * about - not that a counter went up. Its label has to be the one already committed to storage,
   * or the row a restart shows and the row shown now would disagree.
   */
  it('creates the conversation for a first message, with the label the writer committed', () => {
    const convs = new Map<string, Conversation>();

    expect(mergeFcmMessagesIntoConversations([message()], convs, 'me', placeholders())).toBe(1);

    const made = convs.get('grp-aaaa-bbbb');
    expect(made).toBeDefined();
    expect(made?.name).toBe('Alice');
    expect(made?.contactName).toBe('Alice');
    // `pending` and not `active`: no Welcome has been applied in this process, and claiming
    // otherwise would offer a sendable conversation on a group whose state is not loaded.
    expect(made?.lifecycle).toBe('pending');
    expect(made?.messages).toHaveLength(1);
    // The sidebar sorts on this, so a conversation created with no timestamp sinks to the bottom -
    // which for the newest message in the app is the wrong end.
    expect(made?.lastMessageAt).toBe(1_700_000_000_000);
    // It is somebody else's message, so it is unread. This is the count the shade already showed.
    expect(made?.unreadCount).toBe(1);
  });

  /**
   * AND WHEN IT CANNOT BE CREATED, IT SAYS SO.
   *
   * A caller with no cache behind it passes no placeholders, and then a message with nowhere to go
   * is still dropped - but the drop is the thing that hid this bug, so it is no longer silent. The
   * caller's own line says the message was injected; only this one can say it went nowhere.
   */
  it('warns rather than silently dropping a message it has no conversation for', () => {
    const convs = new Map<string, Conversation>();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(mergeFcmMessagesIntoConversations([message()], convs, 'me')).toBe(0);
    expect(convs.size).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('grp-aaaa');
    warn.mockRestore();
  });

  it('does nothing, and says nothing, when there is nothing to merge', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(mergeFcmMessagesIntoConversations([], new Map(), 'me', placeholders())).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
