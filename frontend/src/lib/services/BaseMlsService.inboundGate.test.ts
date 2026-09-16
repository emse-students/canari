/**
 * THE INBOUND GATE: THE PRICE OF OPENING THE SOCKET BEFORE THE CLIENT THAT READS IT.
 *
 * The login starts the gateway handshake beside the MLS state load instead of behind it - 182 ms of
 * a 1308 ms cold start, measured on production 2026-09-16 - and the only thing that makes that safe
 * is this queue. A frame delivered to a client that cannot yet decrypt it is not a delayed message,
 * it is a LOST one: the gateway's delivery accounting does not distinguish "handed to a client" from
 * "handled by one", so the server believes it delivered what nobody read.
 *
 * So what is asserted here is not a duration. It is that nothing is processed before the thing that
 * can process it exists, that everything held is replayed, and that it is replayed in the order it
 * arrived - because a Welcome and the Commit behind it admit exactly one order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';

/** @see BaseMlsService.mailboxBarrier.test.ts - same reason the cast is what instantiates the base. */
abstract class Harness extends BaseMlsService {}

/** The routed frames, in the order `routeFrame` was actually called with them. */
type Routed = { msg: Record<string, unknown>; frameType: string }[];

/**
 * A service whose only platform behaviour is to record what reached {@link BaseMlsService.routeFrame}.
 *
 * The gate is the unit under test and the routing is not: every subclass implements its own, and
 * what this file has to prove is true of both.
 */
const makeService = (
  onRoute?: (msg: Record<string, unknown>) => void
): { svc: BaseMlsService; routed: Routed } => {
  const routed: Routed = [];
  const svc = new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');
  Object.assign(svc, {
    routeFrame: async (msg: Record<string, unknown>, frameType: string) => {
      routed.push({ msg, frameType });
      onRoute?.(msg);
    },
  });
  return { svc, routed };
};

/** The gate's own seams, reached the way the class reaches them. */
const inner = (svc: BaseMlsService) =>
  svc as unknown as {
    deliverFrame(msg: Record<string, unknown>, frameType: string): Promise<void>;
  };

describe('a socket that is open before MLS is', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('routes nothing at all until the client says it can read a frame', async () => {
    const { svc, routed } = makeService();

    await inner(svc).deliverFrame({ proto: 'AAA', groupId: 'g-1' }, '');
    await inner(svc).deliverFrame({ type: 'typing', groupId: 'g-1' }, 'typing');

    expect(routed).toEqual([]);
  });

  it('replays every held frame once the client can, in arrival order', async () => {
    // ARRIVAL ORDER IS THE ASSERTION. A Welcome opens a group and the Commit behind it moves its
    // epoch; swapped, the second is undecryptable and the first is applied to a state that has
    // already moved. Nothing downstream re-sorts them, so this order is the only one there is.
    const { svc, routed } = makeService();

    await inner(svc).deliverFrame({ proto: 'W', isWelcome: true }, '');
    await inner(svc).deliverFrame({ proto: 'C', isCommit: true }, '');
    await inner(svc).deliverFrame({ type: 'welcome_request' }, 'welcome_request');

    await svc.markInboundReady();

    expect(routed.map((r) => r.msg.proto ?? r.msg.type)).toEqual(['W', 'C', 'welcome_request']);
  });

  it('carries each frame its own type, not the type of whichever frame it followed', async () => {
    const { svc, routed } = makeService();

    await inner(svc).deliverFrame({ type: 'typing' }, 'typing');
    await inner(svc).deliverFrame({ proto: 'AAA' }, '');

    await svc.markInboundReady();

    expect(routed.map((r) => r.frameType)).toEqual(['typing', '']);
  });

  it('routes a frame straight through once the gate is open, holding nothing', async () => {
    const { svc, routed } = makeService();
    await svc.markInboundReady();

    await inner(svc).deliverFrame({ proto: 'AAA' }, '');

    expect(routed).toHaveLength(1);
  });

  it('drains once, not once per call - a second declaration replays nothing', async () => {
    // Idempotent because the caller should not have to know whether a socket was ever open, and
    // because a reconnect declares a client that has been ready for the whole session.
    const { svc, routed } = makeService();
    await inner(svc).deliverFrame({ proto: 'AAA' }, '');

    await svc.markInboundReady();
    await svc.markInboundReady();

    expect(routed).toHaveLength(1);
  });

  it('keeps draining after one held frame throws, because the rest are not its fault', async () => {
    // PER FRAME, and the batch is exactly the frames that arrived while this client could not
    // answer for itself - the worst possible batch to discard as a group.
    const seen: string[] = [];
    const { svc } = makeService((msg) => {
      seen.push(String(msg.proto));
      if (msg.proto === 'B') throw new Error('unroutable');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await inner(svc).deliverFrame({ proto: 'A' }, '');
    await inner(svc).deliverFrame({ proto: 'B' }, '');
    await inner(svc).deliverFrame({ proto: 'C' }, '');
    await svc.markInboundReady();

    expect(seen).toEqual(['A', 'B', 'C']);
    expect(errors).toHaveBeenCalledOnce();
  });

  it('says so when a session ends with frames still held, instead of dropping them in silence', async () => {
    // A non-zero count here means a login gave up between opening its socket and being ready, and
    // that is the one thing this queue can be wrong about. Nothing else would ever report it.
    const { svc } = makeService();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await inner(svc).deliverFrame({ proto: 'AAA' }, '');

    svc.destroy();

    expect(warn.mock.calls.flat().join(' ')).toContain('1 frame(s) still held');
  });

  it('is silent on a destroy that held nothing, which is every ordinary session', async () => {
    const { svc } = makeService();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await svc.markInboundReady();

    svc.destroy();

    expect(warn.mock.calls.flat().join(' ')).not.toContain('still held');
  });

  it('forgets what it dropped, so a later declaration cannot replay a dead session', async () => {
    const { svc, routed } = makeService();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await inner(svc).deliverFrame({ proto: 'AAA' }, '');

    svc.destroy();
    await svc.markInboundReady();

    expect(routed).toEqual([]);
  });
});
