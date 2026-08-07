import { retransmitRecentSends } from './messaging';
import { noteSentFrame, resetRecentSendsForTests } from '$lib/utils/chat/recentSends';
import type { OutboxEntry } from '$lib/db';

/**
 * A retransmission must never be retained as if it were a new send.
 *
 * `recentSends` exists so a peer whose ratchet rewound can be handed the same payload again. The
 * repair is meant to be bounded: the ring ages out after five minutes, so a group that goes quiet
 * stops costing anything. Retransmitting through the ordinary outbox path broke both bounds at
 * once - each replay was re-noted under a fresh `crypto.randomUUID()` and a fresh `sentAt`, so the
 * window never aged out and the id-based dedup no longer matched the payload it was replacing. The
 * ring stopped being a decaying buffer of recent sends and became a permanent playlist, replayed in
 * full on every `decrypt_failed`.
 *
 * Measured on production 2026-08-07: three web clients held one DM at ~430 frames/minute for
 * thirteen minutes - 4 921 frames queued for a single phone, which then spent eighteen minutes
 * draining them behind a sync banner - with nobody typing a word. It ended only because the ring
 * lives in memory and a tab reloaded.
 *
 * This file pins the half that lives in `messaging.ts`: every replay is FLAGGED. The other half -
 * that the flusher honours the flag and skips `noteSentFrame` - is pinned in `outbox.test.ts`,
 * where the real flusher runs. Both are needed: a flag nobody reads and a reader with nothing
 * flagged are each individually green and together useless.
 */
const CONVO = 'group-1';

vi.mock('./outbox', () => ({ enqueueOutboxMessage: vi.fn().mockResolvedValue(undefined) }));

const { enqueueOutboxMessage } = await import('./outbox');
const enqueued = (): OutboxEntry[] =>
  vi.mocked(enqueueOutboxMessage).mock.calls.map((c) => c[0] as OutboxEntry);

const proto = (n: number) => new Uint8Array([n, n, n]);

describe('retransmission amplification', () => {
  beforeEach(() => {
    resetRecentSendsForTests();
    vi.clearAllMocks();
  });

  it('flags every replayed payload, so the flusher will not retain it again', async () => {
    noteSentFrame(CONVO, 'msg-a', proto(1));
    noteSentFrame(CONVO, 'msg-b', proto(2));

    const count = await retransmitRecentSends(CONVO, 120_000);

    expect(count).toBe(2);
    const entries = enqueued();
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.kind).toBe('control');
      expect(e.isRetransmission).toBe(true);
    }
  });

  it('lets the ring age out, so a quiet group stops replaying anything', async () => {
    const sixMinutesAgo = Date.now() - 6 * 60_000;
    noteSentFrame(CONVO, 'msg-old', proto(1), sixMinutesAgo);

    // Nothing retained inside the window: the answer is "unrecoverable", which the caller logs.
    // That honest zero is the whole point - it is what ends a desync instead of feeding it.
    expect(await retransmitRecentSends(CONVO, 120_000)).toBe(0);
    expect(enqueued()).toHaveLength(0);
  });

  it('never replays wider than the ring retains, whatever a peer asks for', async () => {
    noteSentFrame(CONVO, 'msg-recent', proto(1), Date.now() - 60_000);
    noteSentFrame(CONVO, 'msg-ancient', proto(2), Date.now() - 10 * 60_000);

    // A peer asking for an hour still only gets what is inside the 5-minute retention.
    expect(await retransmitRecentSends(CONVO, 60 * 60_000)).toBe(1);
  });
});
