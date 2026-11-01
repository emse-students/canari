import { SvelteMap } from 'svelte/reactivity';
import type { ChatMessage, Conversation } from '$lib/types';
import { dateBackgroundSentRow, parseOutboxSentLine } from './outboxMirror';

/**
 * A message the native background service sent (a notification quick reply, a drain while the app
 * was shut) is dated by the server's receive time like a foreground send (owner, 2026-10-31): the
 * native side writes it next to the id in `outbox_sent.ndjson`, and the app takes it at login.
 */
describe('outbox_sent.ndjson lines', () => {
  it('reads `id<TAB>receivedAt`, and a bare id from an older native build', () => {
    expect(parseOutboxSentLine('m1\t1700000000123')).toEqual({
      id: 'm1',
      receivedAt: 1_700_000_000_123,
    });
    expect(parseOutboxSentLine('m1')).toEqual({ id: 'm1' });
    expect(parseOutboxSentLine('m1\t0')).toEqual({ id: 'm1' });
    expect(parseOutboxSentLine('  ')).toBeNull();
  });
});

describe('dateBackgroundSentRow', () => {
  const row = (id: string, sentAt: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    senderId: 'me',
    content: 'x',
    timestamp: new Date(sentAt),
    isOwn: true,
    ...extra,
  });

  it('dates the row, draws it sent, and moves it to its server time', () => {
    const peer = row('peer', 5_000, { isOwn: false, senderId: 'p', serverTimestamp: 5_000 });
    const reply = row('reply', 9_000, { status: 'pending' });
    const conversations = new SvelteMap<string, Conversation>([
      [
        'g1',
        {
          id: 'g1',
          name: 'g1',
          contactName: 'g1',
          lifecycle: 'active',
          mlsStateHex: null,
          messages: [peer, reply],
        },
      ],
    ]);
    // Accepted by the server BEFORE the peer's message, whatever this device's clock said.
    expect(dateBackgroundSentRow(conversations, 'reply', 4_000)).toBe(true);
    const messages = conversations.get('g1')!.messages;
    expect(messages.map((m) => m.id)).toEqual(['reply', 'peer']);
    expect(messages[0]).toMatchObject({ serverTimestamp: 4_000, status: 'sent' });
  });

  it('changes nothing for an id no conversation holds (a control frame)', () => {
    const conversations = new SvelteMap<string, Conversation>();
    expect(dateBackgroundSentRow(conversations, 'ctl', 4_000)).toBe(false);
  });
});
