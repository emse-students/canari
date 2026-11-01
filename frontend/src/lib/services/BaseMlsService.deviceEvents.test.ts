import { describe, expect, it, vi } from 'vitest';

// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));

import { BaseMlsService } from './BaseMlsService';
import type { DeviceEvent } from '$lib/mls-client/deviceTrust';

/**
 * The device events reach the notices: the 512-event store in the sealed state DRAINS once a
 * consumer is registered (a review finding of #2268 - nothing took them, so they piled up to the
 * bound), and with no consumer they are left in place rather than taken and dropped.
 */
type Proto = {
  setDeviceEventConsumer: (c: ((e: DeviceEvent[]) => Promise<boolean>) | null) => void;
  handOverDeviceEvents: (why: string) => Promise<boolean>;
};
const proto = BaseMlsService.prototype as unknown as Proto;

const event: DeviceEvent = {
  groupId: 'g1',
  epoch: 3,
  identity: 'bob:web-2',
  keyFingerprint: 'aa',
  trust: 'first-sight',
  addedBy: 'bob:phone-1',
  memberAlreadyPresent: true,
};

function makeCtx(pending: DeviceEvent[]) {
  const ctx = {
    deviceEventConsumer: null as ((e: DeviceEvent[]) => Promise<boolean>) | null,
    deviceEventHandOver: Promise.resolve() as Promise<unknown>,
    takeDeviceEventsNative: vi.fn(async () => pending.splice(0)),
    handOverDeviceEvents: proto.handOverDeviceEvents,
    setDeviceEventConsumer: proto.setDeviceEventConsumer,
  };
  return ctx;
}

describe('BaseMlsService device events - handed to the notices', () => {
  it('takes nothing while no consumer listens, and hands everything over at registration', async () => {
    const pending = [event];
    const ctx = makeCtx(pending);
    await proto.handOverDeviceEvents.call(ctx, 'drain end');
    expect(ctx.takeDeviceEventsNative).not.toHaveBeenCalled();

    const consumer = vi.fn(async () => true);
    ctx.setDeviceEventConsumer(consumer);
    await ctx.deviceEventHandOver;
    expect(consumer).toHaveBeenCalledWith([event]);
    expect(pending).toEqual([]);
  });

  it('keeps delivering after a consumer that threw, which is logged', async () => {
    const pending = [event];
    const ctx = makeCtx(pending);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consumer = vi.fn(async (): Promise<boolean> => {
      throw new Error('boom');
    });
    ctx.setDeviceEventConsumer(consumer);
    await ctx.deviceEventHandOver;
    expect(error).toHaveBeenCalled();

    pending.push({ ...event, identity: 'bob:web-3' });
    await ctx.handOverDeviceEvents('drain end');
    expect(consumer).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  // A notice the server's evidence did not answer for is PARKED by the consumer; on a quiet account
  // no new event would ever come to retry it. Every hand-over - registration, each drain end (so
  // each reconnect and resume), each own Add - is the durable moment it is retried.
  it('hands an empty take over too, so the consumer retries what it parked', async () => {
    const ctx = makeCtx([]);
    const consumer = vi.fn(async () => true);
    ctx.setDeviceEventConsumer(consumer);
    await ctx.deviceEventHandOver;
    expect(consumer).toHaveBeenCalledWith([]);
    await ctx.handOverDeviceEvents('drain end');
    expect(consumer).toHaveBeenCalledTimes(2);
  });

  // The verdict an answer leg reads before deciding who is withheld: anything short of a consumer
  // that decided every event is NOT settled, and the answer refuses.
  describe('the settle verdict', () => {
    it('is false with no consumer registered', async () => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const ctx = makeCtx([event]);
      expect(await proto.handOverDeviceEvents.call(ctx, 'history answer')).toBe(false);
      debug.mockRestore();
    });

    it('is false when the take fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ctx = makeCtx([]);
      ctx.deviceEventConsumer = vi.fn(async () => true);
      ctx.takeDeviceEventsNative.mockRejectedValueOnce(new Error('locked'));
      expect(await proto.handOverDeviceEvents.call(ctx, 'history answer')).toBe(false);
      error.mockRestore();
    });

    it('is false when the consumer throws', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ctx = makeCtx([event]);
      ctx.deviceEventConsumer = vi.fn(async (): Promise<boolean> => {
        throw new Error('boom');
      });
      expect(await proto.handOverDeviceEvents.call(ctx, 'history answer')).toBe(false);
      error.mockRestore();
    });

    it("is the consumer's own answer otherwise", async () => {
      const ctx = makeCtx([event]);
      ctx.deviceEventConsumer = vi.fn(async () => false);
      expect(await proto.handOverDeviceEvents.call(ctx, 'history answer')).toBe(false);
      ctx.deviceEventConsumer = vi.fn(async () => true);
      expect(await proto.handOverDeviceEvents.call(ctx, 'history answer')).toBe(true);
    });
  });
});
