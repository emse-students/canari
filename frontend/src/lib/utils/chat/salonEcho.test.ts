import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation } from '$lib/types';
import { applySalonEchoChange, nextEchoMessages } from './salonEcho';

vi.mock('$lib/mls-client/tabMessageSync', () => ({ publishTabMessageUpdate: vi.fn() }));
import { publishTabMessageUpdate } from '$lib/mls-client/tabMessageSync';

function row(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    senderId: 'me',
    content: 'x',
    timestamp: new Date(1000),
    isOwn: true,
    ...extra,
  };
}
const echo = (id = 'local', status: ChatMessage['status'] = 'sending') =>
  row(id, { status, awaitingServerId: true });

describe('nextEchoMessages', () => {
  it('moves the state of the echo and nothing else', () => {
    const other = row('other');
    const next = nextEchoMessages([other, echo()], 'local', { kind: 'state', status: 'error' });
    expect(next?.[0]).toBe(other);
    expect(next?.[1]).toMatchObject({ id: 'local', status: 'error', awaitingServerId: true });
  });

  it('re-keys in place on the server id, clearing the flag', () => {
    const next = nextEchoMessages([row('a'), echo(), row('b')], 'local', {
      kind: 'settled',
      serverId: 'srv',
    });
    expect(next?.map((m) => m.id)).toEqual(['a', 'srv', 'b']);
    expect(next?.[1]).toMatchObject({ status: 'sent' });
    expect(next?.[1].awaitingServerId).toBeUndefined();
  });

  it('never duplicates: the server row already there means the echo is dropped', () => {
    const next = nextEchoMessages([row('srv'), echo()], 'local', {
      kind: 'settled',
      serverId: 'srv',
    });
    expect(next?.map((m) => m.id)).toEqual(['srv']);
  });

  it('without a server id the row is `sent` but stays flagged, waiting for the frame', () => {
    const next = nextEchoMessages([echo()], 'local', { kind: 'settled' });
    expect(next?.[0]).toMatchObject({ id: 'local', status: 'sent', awaitingServerId: true });
    expect(nextEchoMessages(next!, 'local', { kind: 'settled' })).toBeNull();
  });

  it('a second answer is a no-op', () => {
    const settled = nextEchoMessages([echo()], 'local', { kind: 'settled', serverId: 'srv' })!;
    expect(nextEchoMessages(settled, 'local', { kind: 'settled', serverId: 'srv' })).toBeNull();
  });

  it('touches only a flagged echo: another member message with that id is left alone', () => {
    const theirs = row('local', { isOwn: false });
    expect(nextEchoMessages([theirs], 'local', { kind: 'settled', serverId: 'srv' })).toBeNull();
  });
});

describe('applySalonEchoChange', () => {
  function store(messages: ChatMessage[]) {
    const map = new Map<string, Conversation>([
      ['channel_c', { id: 'channel_c', messages, lastMessageAt: 1000 } as never],
    ]);
    return map;
  }

  it('announces the re-keyed row to the sibling tabs, once', () => {
    vi.mocked(publishTabMessageUpdate).mockClear();
    const map = store([echo()]);
    const log = vi.fn();

    expect(
      applySalonEchoChange(map, 'channel_c', 'local', { kind: 'settled', serverId: 'srv' }, log)
    ).toBe(true);
    expect(publishTabMessageUpdate).toHaveBeenCalledTimes(1);
    expect(map.get('channel_c')?.messages.map((m) => m.id)).toEqual(['srv']);

    // The broadcast frame arrives afterwards and finds nothing to settle: no second announcement.
    expect(
      applySalonEchoChange(map, 'channel_c', 'local', { kind: 'settled', serverId: 'srv' }, log)
    ).toBe(false);
    expect(publishTabMessageUpdate).toHaveBeenCalledTimes(1);
  });
});
