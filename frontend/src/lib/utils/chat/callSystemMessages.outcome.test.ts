import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: async () => (id: string) => `name-of-${id}`,
}));
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));
vi.mock('$lib/notifications/preferencesApi', () => ({
  fetchNotificationPreferences: vi.fn(),
  saveDisabledCategories: vi.fn(),
  saveGroupNotificationLevel: vi.fn().mockResolvedValue(undefined),
  saveGroupCallsAllowed: vi.fn().mockResolvedValue(undefined),
  fetchChannelNotificationLevel: vi.fn(),
}));
vi.mock('$lib/stores/appVersionCheck.svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverCallsMode: () => 'audio',
  getAppVersionCheck: () => ({}),
  refreshAppVersionCheck: async () => {},
}));

import {
  handleCallSignalForChat,
  patchCallRecordServerTime,
  recordCallEnded,
  recordCallStarted,
  setCallSystemMessageContext,
  type CallSystemMessageContext,
} from './callSystemMessages';
import { mkCallStartedEnvelope, parseEnvelope, serializeEnvelope } from '$lib/envelope';
import { setLocale } from '$lib/paraglide/runtime';
import { canari } from '$lib/proto/canari.js';
import type { Conversation } from '$lib/types';

/** When the call event happened, as its frame dates it (`receivedNoticeTime`). */
const AT = { timestamp: new Date(1_700_000_000_000), serverTimestamp: 1_700_000_000_040 };

const G = '0b9f3d7e-1111-4222-8333-444455556666';
const R = canari.CallEndReason;

/** A context whose `addMessageToChat` really appends, so the timeline can be read back. */
function makeCtx() {
  const conversations = new SvelteMap<string, Conversation>([
    [G, { id: G, messages: [] } as unknown as Conversation],
  ]);
  const addMessageToChat = vi.fn(
    async (
      _s: string,
      content: string,
      _c: string,
      o?: { messageId?: string; soleWriter?: boolean }
    ) => {
      const convo = conversations.get(G)!;
      conversations.set(G, {
        ...convo,
        messages: [...convo.messages, { id: o?.messageId, content }],
      } as unknown as Conversation);
    }
  );
  const ctx: CallSystemMessageContext = {
    userId: 'me',
    deviceKey: () => 'dk',
    storage: null,
    conversations,
    addMessageToChat: addMessageToChat as unknown as CallSystemMessageContext['addMessageToChat'],
  };
  const rows = () =>
    conversations.get(G)!.messages.map((m) => {
      const env = parseEnvelope(m.content);
      if (env.kind !== 'system') throw new Error('expected a system row');
      return env;
    });
  return { ctx, rows, conversations, addMessageToChat };
}

describe('the ONE call-record writer (B15)', () => {
  beforeEach(() => {
    setLocale('fr', { reload: false });
    // The idempotence set lives in the module: clearing the context clears it.
    setCallSystemMessageContext(null);
  });

  it.each([
    ['cancelled', 'Appel annulé'],
    ['not-answered', 'Appel sans réponse'],
    ['declined', 'Appel refusé'],
    ['busy', 'Contact occupé'],
  ] as const)(
    'the caller reads %s as its own sentence, never a duration',
    async (outcome, text) => {
      const { ctx, rows } = makeCtx();
      await recordCallStarted(ctx, G, 'c1', 'me', AT);
      await recordCallEnded(ctx, G, 'c1', AT, outcome, 'me');
      expect(rows()).toHaveLength(1);
      expect(rows()[0].text).toBe(text);
      expect(rows()[0].callEvent?.outcome).toBe(outcome);
      expect(rows()[0].text).not.toContain('a duré');
    }
  );

  it('the callee reads a missed call for everything but a ring it refused', async () => {
    for (const [i, outcome] of (['cancelled', 'not-answered', 'busy'] as const).entries()) {
      const { ctx, rows } = makeCtx();
      await recordCallStarted(ctx, G, `m${i}`, 'caller', AT);
      await recordCallEnded(ctx, G, `m${i}`, AT, outcome, 'caller');
      expect(rows()[0].text).toBe('Appel manqué de name-of-caller');
    }
    const { ctx, rows } = makeCtx();
    await recordCallStarted(ctx, G, 'd1', 'caller', AT);
    await recordCallEnded(ctx, G, 'd1', AT, 'declined', 'caller');
    expect(rows()[0].text).toBe('Appel refusé');
  });

  it('an answered call keeps its duration', async () => {
    const { ctx, rows } = makeCtx();
    await recordCallStarted(ctx, G, 'a1', 'caller', AT);
    await recordCallEnded(ctx, G, 'a1', AT);
    expect(rows()[0].text).toContain('a démarré un appel qui a duré');
  });

  it('is idempotent and final: a second end, or a late start, writes nothing more', async () => {
    const { ctx, rows } = makeCtx();
    await recordCallStarted(ctx, G, 'i1', 'me', AT);
    await recordCallEnded(ctx, G, 'i1', AT, 'not-answered', 'me');
    await recordCallEnded(ctx, G, 'i1', AT, 'busy', 'me');
    await recordCallEnded(ctx, G, 'i1', AT);
    await recordCallStarted(ctx, G, 'i1', 'me', AT);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].text).toBe('Appel sans réponse');
  });

  it('a busy answer racing the "started" row leaves ONE final row', async () => {
    const { ctx, rows } = makeCtx();
    const started = recordCallStarted(ctx, G, 'r1', 'me', AT);
    await recordCallEnded(ctx, G, 'r1', AT, 'busy', 'me');
    await started;
    expect(rows()).toHaveLength(1);
    expect(rows()[0].text).toBe('Contact occupé');
  });

  it('keeps a message that arrived while the end waited for the display name', async () => {
    const { ctx, conversations } = makeCtx();
    await recordCallStarted(ctx, G, 's1', 'me', AT);
    const ending = recordCallEnded(ctx, G, 's1', AT, 'not-answered', 'me');
    const convo = conversations.get(G)!;
    conversations.set(G, {
      ...convo,
      messages: [...convo.messages, { id: 'later', content: 'x' }],
    } as unknown as Conversation);
    await ending;
    const ids = conversations.get(G)!.messages.map((x) => x.id);
    expect(ids).toEqual(['call-s1', 'later']);
    const first = parseEnvelope(conversations.get(G)!.messages[0].content);
    expect(first.kind === 'system' && first.text).toBe('Appel sans réponse');
  });

  it('finalizes the row that appeared while an end with no row waited', async () => {
    const { ctx, conversations } = makeCtx();
    const ending = recordCallEnded(ctx, G, 'f1', AT, 'busy', 'me');
    const convo = conversations.get(G)!;
    conversations.set(G, {
      ...convo,
      messages: [
        {
          id: 'call-f1',
          content: serializeEnvelope(mkCallStartedEnvelope('me', 'f1', 'me', 1)),
        },
      ],
    } as unknown as Conversation);
    await ending;
    const msgs = conversations.get(G)!.messages;
    expect(msgs).toHaveLength(1);
    const env = parseEnvelope(msgs[0].content);
    expect(env.kind === 'system' && env.callEvent?.outcome).toBe('busy');
  });

  it('writes its rows as the sole writer, so a bulk ingest never buffers them', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await recordCallStarted(ctx, G, 'w1', 'caller', AT);
    await recordCallEnded(ctx, G, 'w2', AT, 'busy', 'caller');
    const options = addMessageToChat.mock.calls.map((c) => c[3]);
    expect(options).toHaveLength(2);
    expect(options.every((o) => o?.soleWriter === true)).toBe(true);
  });

  it('writes no row for a call that rang nobody (no outcome, no row)', async () => {
    const { ctx, rows } = makeCtx();
    await recordCallEnded(ctx, G, 'n1', AT, undefined, 'me');
    expect(rows()).toHaveLength(0);
  });
});

describe('the signal path of the record', () => {
  beforeEach(() => {
    setLocale('fr', { reload: false });
    setCallSystemMessageContext(null);
  });

  const hangup = (reason?: number) => ({ callId: 'h1', hangup: true, endReason: reason });

  it('a busy callee device, which never rang, still owes its owner a missed call', async () => {
    const { ctx, rows } = makeCtx();
    await handleCallSignalForChat(ctx, 'caller', G, hangup(R.CALL_END_REASON_BUSY), 'me', AT);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].text).toBe('Appel manqué de name-of-caller');
  });

  it('writes no missed call for a ring this account refused elsewhere, or its own hangup', async () => {
    const a = makeCtx();
    await handleCallSignalForChat(a.ctx, 'me', G, hangup(R.CALL_END_REASON_DECLINED), 'me', AT);
    setCallSystemMessageContext(null);
    const b = makeCtx();
    await handleCallSignalForChat(b.ctx, 'me', G, hangup(R.CALL_END_REASON_CANCELLED), 'me', AT);
    expect(a.rows()).toHaveLength(0);
    expect(b.rows()).toHaveLength(0);
  });

  it('an ordinary hangup with no row writes nothing', async () => {
    const { ctx, rows } = makeCtx();
    await handleCallSignalForChat(ctx, 'caller', G, hangup(), 'me', AT);
    expect(rows()).toHaveLength(0);
  });

  it('a rung invite then a CANCELLED hangup reads missed, not "lasted less than a minute"', async () => {
    const { ctx, rows } = makeCtx();
    await handleCallSignalForChat(ctx, 'caller', G, { callId: 'h1', offerSdp: 'START' }, 'me', AT);
    await handleCallSignalForChat(ctx, 'caller', G, hangup(R.CALL_END_REASON_CANCELLED), 'me', AT);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].text).toBe('Appel manqué de name-of-caller');
  });

  it('the caller device records a DECLINED hangup it receives, once', async () => {
    const { ctx, rows } = makeCtx();
    await recordCallStarted(ctx, G, 'h1', 'me', AT);
    await handleCallSignalForChat(ctx, 'callee', G, hangup(R.CALL_END_REASON_DECLINED), 'me', AT);
    await handleCallSignalForChat(ctx, 'callee', G, hangup(R.CALL_END_REASON_DECLINED), 'me', AT);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].text).toBe('Appel refusé');
  });

  it('a busy frame writes nothing here: the caller device writes its own record', async () => {
    const { ctx, rows } = makeCtx();
    await handleCallSignalForChat(ctx, 'callee', G, { callId: 'h1', busy: true }, 'me', AT);
    expect(rows()).toHaveLength(0);
  });
});

describe('a call record is dated by its frame, never by when this device drained it', () => {
  beforeEach(() => {
    setLocale('fr', { reload: false });
    setCallSystemMessageContext(null);
  });

  const dating = (o: unknown) => o as { timestamp?: Date; serverTimestamp?: number };

  it('the started row carries the invite frame instant and its server time', async () => {
    const { ctx, rows, addMessageToChat } = makeCtx();
    await handleCallSignalForChat(ctx, 'caller', G, { callId: 't1', offerSdp: 'START' }, 'me', AT);
    const options = dating(addMessageToChat.mock.calls[0][3]);
    expect(options.timestamp?.getTime()).toBe(AT.timestamp.getTime());
    expect(options.serverTimestamp).toBe(AT.serverTimestamp);
    expect(rows()[0].callEvent?.startedAt).toBe(AT.timestamp.getTime());
  });

  it('a missed call drained late, with no started row, is dated by the hangup frame', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    const late = { timestamp: new Date(1_700_000_600_000), serverTimestamp: 1_700_000_600_030 };
    await handleCallSignalForChat(
      ctx,
      'caller',
      G,
      { callId: 't2', hangup: true, endReason: R.CALL_END_REASON_CANCELLED },
      'me',
      late
    );
    const options = dating(addMessageToChat.mock.calls[0][3]);
    expect(options.timestamp?.getTime()).toBe(late.timestamp.getTime());
    expect(options.serverTimestamp).toBe(late.serverTimestamp);
  });

  it('a duration is measured on the server clock, never one phone against another', async () => {
    const { ctx, rows } = makeCtx();
    await recordCallStarted(ctx, G, 't3', 'caller', AT);
    // The hangup sender's clock runs TEN minutes ahead of the inviter's; the server says three.
    const end = {
      timestamp: new Date(AT.timestamp.getTime() + 10 * 60_000),
      serverTimestamp: AT.serverTimestamp + 3 * 60_000,
    };
    await recordCallEnded(ctx, G, 't3', end);
    expect(rows()[0].callEvent?.endedAt).toBe(end.timestamp.getTime());
    expect(rows()[0].text).toBe('name-of-caller a démarré un appel qui a duré 3 minutes');
  });

  it("with no server time at its OWN end, it is this device's own start row and act", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // This device wrote the start row at T; it ended the call itself two minutes later.
      const T = AT.timestamp.getTime() + 3_600_000;
      vi.setSystemTime(T);
      const { ctx, rows } = makeCtx();
      await recordCallStarted(ctx, G, 't5', 'caller', { timestamp: AT.timestamp });
      // Finalised much later: the clock at finalisation is never read.
      vi.setSystemTime(T + 5 * 3_600_000);
      await recordCallEnded(ctx, G, 't5', { timestamp: new Date(T + 2 * 60_000), ownAct: true });
      expect(rows()[0].text).toBe('name-of-caller a démarré un appel qui a duré 2 minutes');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a remote end drained hours late measures the call, not the drain', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(AT.timestamp.getTime());
      const { ctx, rows } = makeCtx();
      await recordCallStarted(ctx, G, 't6', 'caller', AT);
      vi.setSystemTime(AT.timestamp.getTime() + 6 * 3_600_000);
      await handleCallSignalForChat(ctx, 'caller', G, { callId: 't6', hangup: true }, 'me', {
        timestamp: new Date(AT.timestamp.getTime() + 4 * 60_000),
        serverTimestamp: AT.serverTimestamp + 4 * 60_000,
      });
      expect(rows()[0].text).toBe('name-of-caller a démarré un appel qui a duré 4 minutes');
    } finally {
      vi.useRealTimers();
    }
  });

  it("the own hangup's server time is patched onto a row its end created, never over a start", async () => {
    const { ctx, conversations, addMessageToChat } = makeCtx();
    // A missed call written by the end itself, with no server time yet.
    await recordCallEnded(ctx, G, 't7', { timestamp: AT.timestamp, ownAct: true }, 'busy', 'me');
    expect(
      (addMessageToChat.mock.calls[0][3] as { serverTimestamp?: number }).serverTimestamp
    ).toBeUndefined();
    await patchCallRecordServerTime(ctx, G, 't7', 1_700_000_000_999);
    const serverTimeOf = () =>
      (
        conversations.get(G)!.messages.find((x) => x.id === 'call-t7') as {
          serverTimestamp?: number;
        }
      ).serverTimestamp;
    expect(serverTimeOf()).toBe(1_700_000_000_999);
    await patchCallRecordServerTime(ctx, G, 't7', 1);
    expect(serverTimeOf()).toBe(1_700_000_000_999);
  });

  it('a signal with no instant at all is REFUSED with an error and writes nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, rows } = makeCtx();
    await handleCallSignalForChat(
      ctx,
      'caller',
      G,
      { callId: 't4', offerSdp: 'START' },
      'me',
      null
    );
    expect(rows()).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REFUSED'));
    error.mockRestore();
  });
});
