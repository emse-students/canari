import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation } from '$lib/types';
import { applySalonEchoChange, mergeAnnouncedMessage, nextEchoMessages } from './salonEcho';

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

  it('takes the server clock when the answer carries it, and sorts by it', () => {
    // The author's clock ran 2 s ahead: the echo was drawn at 5000, the server stamped it 3000, and
    // somebody else's message stamped 4000 was already drawn below it.
    const theirs = row('theirs', { isOwn: false, timestamp: new Date(4000) });
    const next = nextEchoMessages(
      [
        row('a', { timestamp: new Date(1000) }),
        { ...echo('local'), timestamp: new Date(5000) },
        theirs,
      ],
      'local',
      { kind: 'settled', serverId: 'srv', serverMs: 3000 }
    );
    expect(next?.map((m) => m.id)).toEqual(['a', 'srv', 'theirs']);
    expect(next?.[1]).toMatchObject({ serverTimestamp: 3000 });
    expect(next?.[1].timestamp.getTime()).toBe(3000);

    const later = nextEchoMessages(
      [echo('local'), row('theirs', { isOwn: false, timestamp: new Date(2000) })],
      'local',
      { kind: 'settled', serverId: 'srv', serverMs: 3000 }
    );
    // The server put theirs FIRST: the settled row moves below it, as every other device shows it.
    expect(later?.map((m) => m.id)).toEqual(['theirs', 'srv']);
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
    // ...carrying the client id, so a follower that composed it settles its own echo.
    expect(vi.mocked(publishTabMessageUpdate).mock.calls[0][0]).toMatchObject({
      clientMessageId: 'local',
    });
    expect(map.get('channel_c')?.messages.map((m) => m.id)).toEqual(['srv']);

    // The broadcast frame arrives afterwards and finds nothing to settle: no second announcement.
    expect(
      applySalonEchoChange(map, 'channel_c', 'local', { kind: 'settled', serverId: 'srv' }, log)
    ).toBe(false);
    expect(publishTabMessageUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('an echo is settled by a history load too', () => {
  it('re-keys an echo whose reply carried no id, whatever its state', () => {
    for (const status of ['sending', 'sent'] as const) {
      const next = nextEchoMessages([echo('local', status)], 'local', {
        kind: 'settled',
        serverId: 'srv',
      });
      expect(next?.map((m) => m.id)).toEqual(['srv']);
    }
  });

  it('a null id (typed: the reply carried none) keeps the row addressable by its client id', () => {
    const next = nextEchoMessages([echo()], 'local', { kind: 'settled', serverId: null });
    expect(next?.[0]).toMatchObject({ id: 'local', status: 'sent', awaitingServerId: true });
  });
});

describe('a follower tab that composed a salon message shows ONE row, in both orders', () => {
  // The follower draws the echo; only the leader receives the frame and announces the server row.
  const announced = () => row('srv', { serverTimestamp: 2000, timestamp: new Date(2000) });
  const postReply = { kind: 'settled', serverId: 'srv', serverMs: 2000 } as const;

  it("the leader's announcement first, then the POST reply", () => {
    const merged = mergeAnnouncedMessage([echo()], announced(), 'local');
    expect(merged?.settledEcho).toBe(true);
    expect(merged?.messages.map((m) => m.id)).toEqual(['srv']);
    expect(merged?.messages[0]).toMatchObject({ status: 'sent', awaitingServerId: undefined });

    // The POST reply finds no echo left: nothing changes.
    expect(nextEchoMessages(merged!.messages, 'local', postReply)).toBeNull();
    expect(merged?.messages).toHaveLength(1);
  });

  it("the POST reply first, then the leader's announcement", () => {
    const afterReply = nextEchoMessages([echo()], 'local', postReply)!;
    expect(afterReply.map((m) => m.id)).toEqual(['srv']);

    expect(mergeAnnouncedMessage(afterReply, announced(), 'local')).toBeNull();
    expect(afterReply).toHaveLength(1);
  });

  it('an UNCONFIRMED echo is settled by the announcement, never left beside it', () => {
    const merged = mergeAnnouncedMessage([echo('local', 'unconfirmed')], announced(), 'local');
    expect(merged?.messages).toHaveLength(1);
    expect(merged?.messages[0]).toMatchObject({ id: 'srv', status: 'sent' });
  });

  it('without a client id (old leader, or another author) the row is merged as before', () => {
    const merged = mergeAnnouncedMessage([echo()], announced());
    expect(merged?.settledEcho).toBe(false);
    // The echo has no server time yet, so it is drawn below every dated row (`awaitsServerTime`).
    expect(merged?.messages.map((m) => m.id)).toEqual(['srv', 'local']);
    expect(mergeAnnouncedMessage(merged!.messages, announced())).toBeNull();
  });
});
