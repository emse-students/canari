/**
 * ONE PULL AT A TIME, AND THE ONE ASKED MEANWHILE RUNS ONCE, BEHIND THE DRAIN'S ACK.
 *
 * Two pulls used to run side by side at boot - the reconnect's, then the re-fetch for the
 * conversations the restore had just seeded - and the second listed rows the first one's drain had
 * applied but not yet acknowledged (the drain acks when it ENDS). The repeat was accused as an ack
 * the server forgot: two `[QUEUE] delivery ... arrived twice` lines after each launch on the Mi 9T
 * (`1.6.4-alpha.3`, dev, 2026-11-04). The overlap is deleted here rather than classified: a pull
 * asked while another fetches or the queue drains is OWED, and issued once, after both.
 *
 * Every case drives the real pull, scheduler and drain against a fake server that forgets a row
 * only when it is acknowledged - so "no repeat" is a property of the ordering, not of the fake.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';
import type { MlsQueuedMessage } from '$lib/mls-client/mlsPerGroupScheduler';

/** @see BaseMlsService.deliveryIdentity.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

/** The class's own seams, reached the way the class reaches them. */
const inner = (svc: BaseMlsService) =>
  svc as unknown as {
    fetchPendingMessages(forGroups?: readonly string[]): Promise<void>;
    holdLiveKeyGroupFrame(groupId: string): void;
    enqueueMessage(msg: MlsQueuedMessage, channel: 'live'): void;
    owedPull: unknown;
  };

/** A promise this test resolves by hand, so ordering is decided here rather than by a clock. */
const deferred = (): { promise: Promise<void>; settle: () => void } => {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => (settle = resolve));
  return { promise, settle };
};

/** A queue row as the pull hands it over. */
const row = (id: string, groupId = 'g-1') => ({ id, senderId: 'alice', groupId, proto: 'AQ==' });

describe('a pull asked while another pull or a drain is running', () => {
  let svc: BaseMlsService;
  /** What reached the server and the pipeline, in order - the sequence IS the assertion. */
  let order: string[];
  /** The server's queue: a row leaves it only when an ack names it. */
  let queue: ReturnType<typeof row>[];
  let pulls: number;
  let warned: { mock: { calls: unknown[][] } };
  let logged: { mock: { calls: unknown[][] } };
  /** Held by the test to keep the drain inside a frame's handler. */
  let applying: ReturnType<typeof deferred>;
  /** Run inside the handler, after `applying` - the drain-time asks a case makes. */
  let insideHandler: () => void;

  const repeats = (): string[] =>
    [...warned.mock.calls, ...logged.mock.calls]
      .map((c) => String((c as unknown[])[0]))
      .filter((l) => l.includes('arrived twice'));

  beforeEach(() => {
    svc = makeService();
    order = [];
    queue = [];
    pulls = 0;
    applying = deferred();
    insideHandler = () => undefined;
    warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.assign(svc, {
      userId: 'user-a',
      messageCallback: vi.fn(
        async (
          _s: string,
          _c: Uint8Array,
          _g?: string,
          _w?: boolean,
          _t?: Uint8Array,
          _k?: boolean,
          meta?: { queuedMessageId?: string }
        ) => {
          order.push(`apply:${meta?.queuedMessageId}`);
          await applying.promise;
          insideHandler();
          return true;
        }
      ),
      delivery: {
        ackMessages: vi.fn(async (ids: string[]) => {
          if (ids.length > 0) order.push(`ack:${ids.join(',')}`);
          queue = queue.filter((r) => !ids.includes(r.id));
        }),
        pullPendingMessagesJson: vi.fn(async (opts: { onPage: (rows: unknown[]) => void }) => {
          pulls += 1;
          order.push(`pull-${pulls}`);
          if (queue.length > 0) opts.onPage([...queue]);
        }),
      },
    });
  });

  it('runs ONE more pull for two asks made during a drain, after the drain acknowledged', async () => {
    queue = [row('row-boot')];
    // The reconnect's pull lists the row and the drain starts applying it.
    const first = inner(svc).fetchPendingMessages();
    await vi.waitFor(() => expect(order).toContain('apply:row-boot'));

    // The restore seeds its rows and re-fetches, twice, while that drain has not ended.
    const second = inner(svc).fetchPendingMessages(['g-1']);
    const third = inner(svc).fetchPendingMessages(['g-2']);
    await Promise.resolve();
    expect(pulls).toBe(1);

    applying.settle();
    await Promise.all([first, second, third]);

    // Exactly one second pull, issued only once the drain's ack had gone - so it cannot list the row.
    expect(order).toEqual(['pull-1', 'apply:row-boot', 'ack:row-boot', 'pull-2']);
    expect(repeats()).toEqual([]);
    expect(inner(svc).owedPull).toBeNull();
  });

  it('turns a hold asked inside a drain into the owed pull, issued at the drain end', async () => {
    queue = [row('row-a'), row('row-b')];
    // Each handled frame holds a live key-group frame - a burst of asks from inside the drain.
    insideHandler = () => inner(svc).holdLiveKeyGroupFrame('kg-1');

    const first = inner(svc).fetchPendingMessages();
    await vi.waitFor(() => expect(order).toContain('apply:row-a'));
    applying.settle();
    await first;
    await vi.waitFor(() => expect(pulls).toBe(2));

    // One pull for the burst, behind the drain's ack.
    expect(order).toEqual(['pull-1', 'apply:row-a', 'apply:row-b', 'ack:row-a,row-b', 'pull-2']);
    expect(repeats()).toEqual([]);
    // And that one pull says how many frames it carries, per key group.
    expect(logged.mock.calls.map((c) => String((c as unknown[])[0])).join(' | ')).toContain(
      '2 live frame(s) on 1 key group(s) [kg-1 x2]'
    );
  });

  it('does not hold a barrier on a group the owed pull was not asked for', async () => {
    queue = [row('row-1', 'g-1')];
    const first = inner(svc).fetchPendingMessages();
    await vi.waitFor(() => expect(order).toContain('apply:row-1'));
    void inner(svc).fetchPendingMessages(['g-2']);

    // A group nobody asked the owed pull for: its barrier does not wait for the drain to end.
    let otherSettled = false;
    const other = svc.waitForGroupQueueIdle('test', 'g-3').then(() => (otherSettled = true));
    // The group the owed pull IS for waits until that pull has listed the mailbox.
    let owedSettled = false;
    const owedFor = svc.waitForGroupQueueIdle('test', 'g-2').then(() => (owedSettled = true));
    await other;
    expect(otherSettled).toBe(true);
    expect(owedSettled).toBe(false);
    expect(pulls).toBe(1);

    applying.settle();
    await Promise.all([first, owedFor]);
    expect(owedSettled).toBe(true);
    expect(pulls).toBe(2);
  });

  it('names a pull crossing the ack of a row the SOCKET took in apart, and acks it once', async () => {
    // The pull is out when the live copy arrives; the drain applies it and acks at its end, after
    // the pull had left - so the server is right to list it, and that ack covers it.
    const answer = deferred();
    const pullsSeen = svc as unknown as { delivery: { pullPendingMessagesJson: unknown } };
    pullsSeen.delivery.pullPendingMessagesJson = vi.fn(
      async (opts: { onPage: (rows: unknown[]) => void }) => {
        pulls += 1;
        await answer.promise;
        opts.onPage([row('row-live')]);
      }
    );
    applying.settle();
    const pulling = inner(svc).fetchPendingMessages();
    await vi.waitFor(() => expect(pulls).toBe(1));
    inner(svc).enqueueMessage(
      {
        senderId: 'alice',
        ciphertext: new Uint8Array([1]),
        groupId: 'g-1',
        isWelcome: false,
        isCommit: false,
        queuedMessageId: 'row-live',
      },
      'live'
    );
    await vi.waitFor(() => expect(order).toContain('ack:row-live'));
    answer.settle();
    await pulling;

    expect(svc.deliveryRepeatStats()['pull:crossed-live-ack']).toBe(1);
    expect(svc.deliveryRepeatStats()['pull:done']).toBe(0);
    expect(warned.mock.calls.map((c) => String((c as unknown[])[0])).join('\n')).not.toContain(
      'arrived twice'
    );
    // Not acknowledged a second time: the drain's own ack covers it.
    expect(order.filter((o) => o === 'ack:row-live')).toHaveLength(1);
  });

  it('keeps ACCUSING a pull that lists again a row a PULL took in and acknowledged', async () => {
    // Pulls are single-flight behind the drain's ack, so nothing routine produces this any more.
    queue = [row('row-p')];
    applying.settle();
    await inner(svc).fetchPendingMessages();
    expect(order).toEqual(['pull-1', 'apply:row-p', 'ack:row-p']);

    // A server that forgot the ack it recorded hands the row back.
    queue = [row('row-p')];
    await inner(svc).fetchPendingMessages();

    expect(svc.deliveryRepeatStats()['pull:done']).toBe(1);
    expect(warned.mock.calls.map((c) => String((c as unknown[])[0])).join('\n')).toContain(
      'nothing routine explains this'
    );
  });
});
