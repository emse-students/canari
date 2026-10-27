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
  recordCallEnded,
  recordCallStarted,
  setCallSystemMessageContext,
  type CallSystemMessageContext,
} from './callSystemMessages';
import { parseEnvelope } from '$lib/envelope';
import { setLocale } from '$lib/paraglide/runtime';
import { canari } from '$lib/proto/canari.js';
import type { Conversation } from '$lib/types';

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
      await recordCallStarted(ctx, G, 'c1', 'me');
      await recordCallEnded(ctx, G, 'c1', outcome, 'me');
      expect(rows()).toHaveLength(1);
      expect(rows()[0].text).toBe(text);
      expect(rows()[0].callEvent?.outcome).toBe(outcome);
      expect(rows()[0].text).not.toContain('a duré');
    }
  );

  it('the callee reads a missed call for everything but a ring it refused', async () => {
    for (const [i, outcome] of (['cancelled', 'not-answered', 'busy'] as const).entries()) {
      const { ctx, rows } = makeCtx();
      await recordCallStarted(ctx, G, `m${i}`, 'caller');
      await recordCallEnded(ctx, G, `m${i}`, outcome, 'caller');
      expect(rows()[0].text).toBe('Appel manqué de name-of-caller');
    }
    const { ctx, rows } = makeCtx();
    await recordCallStarted(ctx, G, 'd1', 'caller');
    await recordCallEnded(ctx, G, 'd1', 'declined', 'caller');
    expect(rows()[0].text).toBe('Appel refusé');
  });

  it('an answered call keeps its duration', async () => {
    const { ctx, rows } = makeCtx();
    await recordCallStarted(ctx, G, 'a1', 'caller');
    await recordCallEnded(ctx, G, 'a1');
    expect(rows()[0].text).toContain('a démarré un appel qui a duré');
  });

  it('is idempotent and final: a second end, or a late start, writes nothing more', async () => {
    const { ctx, rows } = makeCtx();
    await recordCallStarted(ctx, G, 'i1', 'me');
    await recordCallEnded(ctx, G, 'i1', 'not-answered', 'me');
    await recordCallEnded(ctx, G, 'i1', 'busy', 'me');
    await recordCallEnded(ctx, G, 'i1');
    await recordCallStarted(ctx, G, 'i1', 'me');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].text).toBe('Appel sans réponse');
  });

  it('a busy answer racing the "started" row leaves ONE final row', async () => {
    const { ctx, rows } = makeCtx();
    const started = recordCallStarted(ctx, G, 'r1', 'me');
    await recordCallEnded(ctx, G, 'r1', 'busy', 'me');
    await started;
    expect(rows()).toHaveLength(1);
    expect(rows()[0].text).toBe('Contact occupé');
  });

  it('keeps a message that arrived while the end waited for the display name', async () => {
    const { ctx, conversations } = makeCtx();
    await recordCallStarted(ctx, G, 's1', 'me');
    const ending = recordCallEnded(ctx, G, 's1', 'not-answered', 'me');
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

  it('writes its rows as the sole writer, so a bulk ingest never buffers them', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await recordCallStarted(ctx, G, 'w1', 'caller');
    await recordCallEnded(ctx, G, 'w2', 'busy', 'caller');
    const options = addMessageToChat.mock.calls.map((c) => c[3]);
    expect(options).toHaveLength(2);
    expect(options.every((o) => o?.soleWriter === true)).toBe(true);
  });

  it('writes no row for a call that rang nobody (no outcome, no row)', async () => {
    const { ctx, rows } = makeCtx();
    await recordCallEnded(ctx, G, 'n1', undefined, 'me');
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
    await handleCallSignalForChat(ctx, 'caller', G, hangup(R.CALL_END_REASON_BUSY), 'me');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].text).toBe('Appel manqué de name-of-caller');
  });

  it('writes no missed call for a ring this account refused elsewhere, or its own hangup', async () => {
    const a = makeCtx();
    await handleCallSignalForChat(a.ctx, 'me', G, hangup(R.CALL_END_REASON_DECLINED), 'me');
    setCallSystemMessageContext(null);
    const b = makeCtx();
    await handleCallSignalForChat(b.ctx, 'me', G, hangup(R.CALL_END_REASON_CANCELLED), 'me');
    expect(a.rows()).toHaveLength(0);
    expect(b.rows()).toHaveLength(0);
  });

  it('an ordinary hangup with no row writes nothing', async () => {
    const { ctx, rows } = makeCtx();
    await handleCallSignalForChat(ctx, 'caller', G, hangup(), 'me');
    expect(rows()).toHaveLength(0);
  });

  it('a rung invite then a CANCELLED hangup reads missed, not "lasted less than a minute"', async () => {
    const { ctx, rows } = makeCtx();
    await handleCallSignalForChat(ctx, 'caller', G, { callId: 'h1', offerSdp: 'START' }, 'me');
    await handleCallSignalForChat(ctx, 'caller', G, hangup(R.CALL_END_REASON_CANCELLED), 'me');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].text).toBe('Appel manqué de name-of-caller');
  });

  it('the caller device records a DECLINED hangup it receives, once', async () => {
    const { ctx, rows } = makeCtx();
    await recordCallStarted(ctx, G, 'h1', 'me');
    await handleCallSignalForChat(ctx, 'callee', G, hangup(R.CALL_END_REASON_DECLINED), 'me');
    await handleCallSignalForChat(ctx, 'callee', G, hangup(R.CALL_END_REASON_DECLINED), 'me');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].text).toBe('Appel refusé');
  });

  it('a busy frame writes nothing here: the caller device writes its own record', async () => {
    const { ctx, rows } = makeCtx();
    await handleCallSignalForChat(ctx, 'callee', G, { callId: 'h1', busy: true }, 'me');
    expect(rows()).toHaveLength(0);
  });
});
