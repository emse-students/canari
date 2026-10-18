/// <reference types="jest" />

import { capLoggedDevices, MessagingService } from './messaging.service';

/**
 * A FAN-OUT PRINTS ONE SUMMARY, NOT A LINE PER DEVICE. Production's container log rolled over in
 * ~20 minutes because one frame queued to ~100 seats wrote ~200 lines. The per-device lines stay
 * for a lone delivery (a Welcome), where they name the one device a reader is following.
 */
describe('MessagingService - log aggregation of a fan-out', () => {
  const queued = (i: number) =>
    ({
      id: `q${i}`,
      recipientId: `u${i}`,
      deviceId: `d${i}`,
      groupId: 'g',
      senderId: 's',
      createdAt: new Date(0),
    }) as never;

  const build = () => {
    const lines: string[] = [];
    const service = Object.create(MessagingService.prototype) as MessagingService;
    Object.assign(service, {
      logger: { log: (m: string) => lines.push(m), warn: jest.fn() },
      redis: { publish: jest.fn().mockResolvedValue(1) },
      sendFcmForQueued: jest.fn().mockImplementation(async (_q, _t, _g, _s, _si, batch) => {
        if (batch) batch.pushed++;
      }),
      scheduleDeferredPush: jest.fn(),
    });
    const deliver = (
      q: never,
      online: boolean,
      batch?: { pushed: number; pushes: Promise<unknown>[] }
    ) =>
      (
        service as unknown as {
          deliverQueuedFrame: (q: never, o: object) => Promise<boolean>;
        }
      ).deliverQueuedFrame(q, {
        tag: 'SEND',
        traceId: 't',
        online,
        silent: false,
        pushable: true,
        batch,
      });
    return { lines, deliver };
  };

  it('writes no per-device line for a fan-out and tallies the pushes instead', async () => {
    const { lines, deliver } = build();
    const batch = { pushed: 0, pushes: [] as Promise<unknown>[] };
    for (let i = 0; i < 50; i++) await deliver(queued(i), false, batch);
    await deliver(queued(99), true, batch);
    await Promise.all(batch.pushes);

    expect(lines).toEqual([]);
    expect(batch.pushes).toHaveLength(50);
    expect(batch.pushed).toBe(50);
  });

  it('keeps the two per-device lines for a lone delivery', async () => {
    const { lines, deliver } = build();
    await deliver(queued(1), true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('online=true');
    expect(lines[1]).toContain('PUBLISHED');
  });

  it('names at most five skipped devices and counts the rest', () => {
    expect(capLoggedDevices(['a', 'b'])).toEqual(['a', 'b']);
    const many = Array.from({ length: 100 }, (_, i) => `d${i}`);
    const capped = capLoggedDevices(many);
    expect(capped).toHaveLength(6);
    expect(capped[5]).toBe('+95 more');
  });
});
