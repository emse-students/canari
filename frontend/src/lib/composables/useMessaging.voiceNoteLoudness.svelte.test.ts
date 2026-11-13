/**
 * A VOICE NOTE CARRIES ITS MEASURED SOUND (owner, 2026-11-12; review of #3394): what the recorder
 * measured while recording reaches `sendVoiceNote`, rides the outbox entry, and is in the message
 * `buildMediaMessage` makes of it - the proto's field 18 and the stored envelope. A recording that
 * could not be measured is still sent, with no loudness, exactly as every note before this.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  globalSession: {},
  globalConvs: {},
  globalMessaging: {},
  globalChannels: {},
  globalNotifs: {},
}));

const enqueueMock = vi.fn();
vi.mock('$lib/utils/chat/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/chat/outbox')>();
  return {
    ...actual,
    enqueueOutboxMessage: (...args: unknown[]) => enqueueMock(...args),
    applyOutboxPendingStatuses: async () => {},
  };
});

await import('./useMessaging.svelte');

type MessagingContext = import('./useMessaging.svelte').MessagingContext;
import type { Conversation } from '$lib/types';
import type { OutboxEntry } from '$lib/db';
import { parseEnvelope } from '$lib/envelope';
import { buildMediaMessage } from '$lib/utils/chat/outbox';
import { decodeAppMessage } from '$lib/proto/codec';

const CONVO = 'conversation-key';
const ref = { mediaId: 'blob-1', key: '00'.repeat(32), iv: '11'.repeat(12) };

function makeContext() {
  const conversations = new SvelteMap<string, Conversation>([
    [
      CONVO,
      {
        id: CONVO,
        name: CONVO,
        messages: [],
        unreadCount: 0,
        lastMessageAt: 0,
        lifecycle: 'active',
      } as never,
    ],
  ]);
  return {
    conversations,
    userId: 'me',
    selectedContact: CONVO,
    selectedNow(this: { selectedContact: string | null }) {
      return this.selectedContact;
    },
    setSendError: vi.fn(),
    log: vi.fn(),
    ensureMls: vi.fn(() => {
      throw new Error('the send path asked the MLS service');
    }),
  } as unknown as MessagingContext;
}

const recording = () =>
  new File([new Uint8Array([1, 2, 3])], 'vocal_1762900000000.webm', { type: 'audio/webm' });

async function freshMessaging() {
  vi.resetModules();
  const { useMessaging } = await import('./useMessaging.svelte');
  return useMessaging();
}

const queued = () => enqueueMock.mock.calls.map(([e]) => e as OutboxEntry);

beforeEach(() => {
  enqueueMock.mockReset();
  enqueueMock.mockResolvedValue(undefined);
  // The upload ceiling cannot be asked here: nothing is refused client-side, as in production.
  vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendVoiceNote - the measured loudness reaches the message', () => {
  it('a measured note: the entry, the proto (field 18) and the envelope carry it', async () => {
    const messaging = await freshMessaging();
    const loudness = { integratedLufs: -21.5, samplePeakDbfs: -6.25 };
    await messaging.sendVoiceNote(recording(), makeContext(), loudness);

    const [entry] = queued();
    expect(entry.kind).toBe('media');
    expect(entry.media?.voiceNote).toBe(true);
    expect(entry.media?.loudness).toEqual(loudness);

    const built = buildMediaMessage({ id: entry.id, sentAt: entry.sentAt }, entry.media!, ref);
    const decoded = decodeAppMessage(built.proto)!;
    expect(decoded.media?.loudness?.integratedLufs).toBeCloseTo(-21.5, 4);
    expect(decoded.media?.loudness?.samplePeakDbfs).toBeCloseTo(-6.25, 4);
    const env = parseEnvelope(built.content);
    expect(env.kind === 'media' && env.media.loudness).toEqual(loudness);
  });

  it('a failed measurement still sends the note - with no loudness anywhere', async () => {
    const messaging = await freshMessaging();
    await messaging.sendVoiceNote(recording(), makeContext(), null);

    const [entry] = queued();
    expect(entry.kind).toBe('media');
    expect(entry.media?.voiceNote).toBe(true);
    expect(entry.media).not.toHaveProperty('loudness');

    const built = buildMediaMessage({ id: entry.id, sentAt: entry.sentAt }, entry.media!, ref);
    expect(decodeAppMessage(built.proto)!.media?.loudness ?? null).toBeNull();
    const env = parseEnvelope(built.content);
    expect(env.kind === 'media' && env.media.loudness).toBeUndefined();
  });
});
