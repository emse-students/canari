// @vitest-environment happy-dom
/**
 * THE HEAL FOR A DEVICE WHOSE MESSAGE TABLE WAS LOST (2026-11-25, the v23 rebuild of 1.8.1,
 * `docs/wiki/frontend/local-store-rebuild.md`): device A lost every row it held and kept only the
 * few that arrived since; device B, a peer of the conversation, holds all 50. The audit bump
 * (`HISTORY_AUDIT_GENERATION` 2) makes A describe itself to B; this pins that B's answer then carries
 * EVERY row A lacks - the ones OLDER than anything A holds included. Nothing on the answering side
 * clips them: not A's `since` (its window, five years on a phone), not the "nothing older exists"
 * range (a scrollback guard, never consulted by the comparison), not B's own reading of its store.
 *
 * Run through the real answer: `answerHistoryDigest` reads B's store, diffs it against A's digest,
 * and `sendHistoryBundleForIds` seals the bundle - only the transport is a stub.
 */
import { answerHistoryDigest } from './historyDiffAnswer';
import { buildHistoryDigest } from './historyManifest';
import { historyRangeStart, NATIVE_DEVICE_WINDOW_MS } from './historyWindow';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import type { IStorage, StoredMessage } from '$lib/db';
import {
  historySealAad,
  mintHistoryAnswerKey,
  openHistoryContent,
  type HistoryAnswerKey,
} from '$lib/crypto/historySeal';
import { fakeHistorySealEngine } from '$lib/mls-client/test/fixtures/fakeHistorySealEngine';

vi.mock('$lib/utils/openExternal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/openExternal')>()),
  // Device A is a phone: its window is the native five years.
  isTauriRuntime: () => true,
}));

const GROUP = 'g-lost';
const A = 'user-a:device-a';
const B = 'user-b:device-b';
const DAY = 86_400_000;
const NOW = Date.now();

let ASK_KEY: HistoryAnswerKey;
beforeAll(async () => {
  ASK_KEY = await mintHistoryAnswerKey(fakeHistorySealEngine());
});

function message(id: string, timestamp: number): StoredMessage {
  return { id, senderId: 'user-b', content: `body of ${id}`, timestamp } as StoredMessage;
}

/** B's store: the 50 rows of the conversation, one a week over the past year, read as it serves them. */
const B_ROWS = Array.from({ length: 50 }, (_, i) => message(`m${i}`, NOW - (50 - i) * 7 * DAY));

function storeOf(rows: StoredMessage[]): IStorage {
  const since = (t: number) => rows.filter((m) => Number(m.timestamp) >= t);
  return {
    getMessages: vi.fn().mockImplementation(async () => rows),
    getMessagesSince: vi.fn().mockImplementation(async (_g: string, t: number) => since(t)),
    // No floor, no recorded start: the conversation row as every device holds it today.
    getConversation: vi.fn().mockResolvedValue(undefined),
  } as unknown as IStorage;
}

/** Every message of every `history_bundle` B sent, its seal opened with A's key. */
async function rowsSentTo(mlsService: ReturnType<typeof createMlsServiceStub>) {
  const ids: string[] = [];
  for (const call of vi.mocked(mlsService.sendMessage).mock.calls) {
    const decoded = decodeAppMessage(call[1] as Uint8Array);
    if (decoded?.system?.event !== 'history_bundle') continue;
    const frame = JSON.parse(decoded.system.data || '{}') as Record<string, unknown>;
    const content = (await openHistoryContent(
      fakeHistorySealEngine(),
      ASK_KEY.secret,
      historySealAad(GROUP, String(frame.requestId), String(frame.to), B),
      String(frame.sealed)
    )) as { messages: Array<{ id: string }> };
    ids.push(...content.messages.map((m) => m.id));
  }
  return ids;
}

describe('a device that lost its message table is healed by a peer that holds the rows', () => {
  it('B sends A all 50 rows, the ones older than anything A still holds included', async () => {
    // A after the loss: two rows that arrived since, both NEWER than every one of B's.
    const aHolds = [message('new-1', NOW - DAY), message('new-2', NOW - 1000)];
    const digest = await buildHistoryDigest(
      aHolds.map((m) => ({ id: m.id, timestamp: Number(m.timestamp) }))
    );
    // What A states: its WINDOW, never the oldest row it holds.
    const since = historyRangeStart(undefined, NOW);
    expect(since).toBeLessThanOrEqual(NOW - NATIVE_DEVICE_WINDOW_MS + DAY);
    expect(since).toBeLessThan(Number(B_ROWS[0].timestamp));

    const mlsService = createMlsServiceStub();
    const log = vi.fn();
    await answerHistoryDigest({
      groupId: GROUP,
      requesterIdentity: A,
      selfIdentity: B,
      digest,
      since,
      requestId: 'req-heal-0001',
      answerKey: ASK_KEY.answerKey,
      deps: { storage: storeOf(B_ROWS), deviceKeyB64: 'k', mlsService, log },
    });

    const sent = await rowsSentTo(mlsService);
    expect(sent.sort()).toEqual(B_ROWS.map((m) => m.id).sort());
    expect(log).toHaveBeenCalledWith(expect.stringContaining('50 to send'));
    // Nothing was held back as below A's window.
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("below the asker's window"));
  });
});
