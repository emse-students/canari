/**
 * The older-messages notice, through a REAL salon history load (channel-encryption section 21.7).
 *
 * Only the server and the seal are stubbed: `decodeChannelMessagePage`, `UnreadableRowTally` and the
 * notice are the production ones, so the count the notice reads is the one the load really kept.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import { encodeAppMessage, mkText } from '$lib/proto/codec';

const listMessages = vi.hoisted(() => vi.fn());
const listReadMarks = vi.hoisted(() => vi.fn());
const openChannelMessage = vi.hoisted(() => vi.fn());

vi.mock('$lib/services/ChannelService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/services/ChannelService')>();
  return { ...actual, channelService: { listMessages, listReadMarks } };
});

vi.mock('$lib/utils/graine/channelSeal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/graine/channelSeal')>();
  return {
    ...actual,
    openChannelMessage,
    // The page entry answers each row with what the stubbed single open answers for it.
    openChannelMessagePage: async (channel: string, rows: readonly unknown[]) => {
      const out = [];
      for (const r of rows) {
        try {
          out.push({ ok: true, bytes: await openChannelMessage(channel, r) });
        } catch (error) {
          out.push({ ok: false, error });
        }
      }
      return out;
    },
  };
});

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
  appendLog: vi.fn(),
}));

const { useConversations } = await import('./useConversations.svelte');
const { GraineV1SessionNotHeldError } = await import('$lib/utils/graine/channelSeal');
const { olderMessagesNoticeId } = await import('$lib/utils/chat/olderMessagesNotice');

const SALON = 'channel_7d2f0aa0-0000-4000-8000-000000000002';
const RAW = SALON.replace(/^channel_/, '');
const NOTICE = olderMessagesNoticeId(SALON);

function makeCtx() {
  return {
    storage: null,
    ensureMls: () => ({}),
    userId: 'u1',
    deviceKeyB64: 'k',
    historyBaseUrl: '',
    messageReactions: new SvelteMap(),
    log: vi.fn(),
    addMessageToChat: vi.fn(),
  } as never;
}

function row(id: string, iso: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    channelId: RAW,
    senderId: 'peer',
    ciphertext: 'x',
    nonce: 'y',
    senderSessionId: `sess-${id}`,
    messageIndex: 0,
    signature: null,
    replyTo: null,
    createdAt: iso,
    pinned: false,
    poll: null,
    ...extra,
  };
}

/** Rows whose id starts with `v1` are unsigned rows under a session this device does not hold. */
function sealAnswers(): void {
  openChannelMessage.mockImplementation(async (_channel: string, r: { id: string }) => {
    if (r.id.startsWith('v1')) throw new GraineV1SessionNotHeldError(`sess-${r.id}`, RAW);
    return encodeAppMessage({ ...mkText(`body ${r.id}`), messageId: r.id });
  });
}

async function load(force = false) {
  const convs = useConversations();
  convs.conversations.set(SALON, {
    id: SALON,
    name: SALON,
    messages: [],
  } as unknown as Conversation);
  await convs.loadHistoryForConversation(SALON, SALON, makeCtx(), { force });
  return convs;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  listReadMarks.mockResolvedValue([]);
  sealAnswers();
});

describe('a salon history load and the older-messages notice', () => {
  it('shows ONE notice, FIRST, when a v1 message row was dropped', async () => {
    listMessages.mockResolvedValue([
      row('v1-a', '2026-10-01T10:00:00.000Z'),
      row('m1', '2026-10-05T10:00:00.000Z'),
      row('m2', '2026-10-06T10:00:00.000Z'),
    ]);

    const convs = await load();

    const ids = convs.conversations.get(SALON)?.messages.map((m) => m.id);
    expect(ids).toEqual([NOTICE, 'm1', 'm2']);
  });

  it('shows none when every row opened (the control)', async () => {
    listMessages.mockResolvedValue([
      row('m1', '2026-10-05T10:00:00.000Z'),
      row('m2', '2026-10-06T10:00:00.000Z'),
    ]);

    const convs = await load();

    expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('shows none when the only v1 rows dropped were SILENT (a reaction or an edit draws no bubble)', async () => {
    listMessages.mockResolvedValue([
      row('v1-r', '2026-10-01T10:00:00.000Z', { silent: true }),
      row('m1', '2026-10-05T10:00:00.000Z'),
    ]);

    const convs = await load();

    expect(convs.conversations.get(SALON)?.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('keeps it FIRST after a forced reload whose page starts later than rows already held', async () => {
    listMessages.mockResolvedValueOnce([
      row('v1-a', '2026-10-01T10:00:00.000Z'),
      row('m0', '2026-10-02T10:00:00.000Z'),
      row('m1', '2026-10-05T10:00:00.000Z'),
    ]);
    const convs = useConversations();
    convs.conversations.set(SALON, {
      id: SALON,
      name: SALON,
      messages: [],
    } as unknown as Conversation);
    const ctx = makeCtx();
    await convs.loadHistoryForConversation(SALON, SALON, ctx);

    // The window moved on: the new page's oldest row is after `m0`, which stays held.
    listMessages.mockResolvedValueOnce([
      row('v1-b', '2026-10-04T10:00:00.000Z'),
      row('m1', '2026-10-05T10:00:00.000Z'),
      row('m2', '2026-10-06T10:00:00.000Z'),
    ]);
    await convs.loadHistoryForConversation(SALON, SALON, ctx, { force: true });

    const ids = convs.conversations.get(SALON)?.messages.map((m) => m.id) ?? [];
    expect(ids[0]).toBe(NOTICE);
    expect(ids.filter((id) => id === NOTICE)).toHaveLength(1);
    expect(ids).toContain('m0');
  });
});
