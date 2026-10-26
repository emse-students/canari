/**
 * A PULL ENDED BY THIS DEVICE'S OWN REVOCATION IS A DESIGNED END, NOT A FAULT.
 *
 * The owner's revocation deleted the server's backlog for the device and ended its session, so the
 * pull's token renewal is refused with the typed `SessionEndedByDeviceRevocationError`. Nothing
 * remains to drain and no reconnect would drain it: an error line claiming the backlog "stays queued"
 * was false twice over. Another device's revocation names a session that is dead for a reason that
 * says nothing about this backlog, so it keeps the accusing line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseMlsService } from '$lib/services/BaseMlsService';
import { SessionEndedByDeviceRevocationError } from '$lib/stores/auth';

abstract class Harness extends BaseMlsService {}

const makeService = (): BaseMlsService =>
  new (Harness as unknown as new (platform: 'web' | 'tauri') => BaseMlsService)('web');

const pullRefusedBy = (svc: BaseMlsService, err: Error): void => {
  Object.assign(svc, {
    userId: 'user-a',
    deviceId: 'dev-1',
    messageCallback: vi.fn().mockResolvedValue(true),
    delivery: {
      ackMessages: vi.fn().mockResolvedValue(undefined),
      pullPendingMessagesJson: vi.fn().mockRejectedValue(err),
    },
  });
};

describe('a pending fetch refused because the device was revoked', () => {
  let svc: BaseMlsService;
  let error: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    svc = makeService();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('ends with one info line and no claim that the backlog stays queued', async () => {
    pullRefusedBy(
      svc,
      new SessionEndedByDeviceRevocationError({ userId: 'user-a', deviceId: 'dev-1' })
    );
    // Two waiters would normally be announced; on a revoked device no pull will ever complete.
    Object.assign(svc, { pendingGroupDrainWaiters: () => 2 });
    await svc.fetchPendingMessages();

    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    const lines = info.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines.filter((l: string) => l.includes('revoked by its owner'))).toHaveLength(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).not.toContain('stays queued');
  });

  it('still accuses when the revocation names another device', async () => {
    pullRefusedBy(
      svc,
      new SessionEndedByDeviceRevocationError({ userId: 'user-a', deviceId: 'dev-other' })
    );
    await svc.fetchPendingMessages();

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('UNDRAINED');
  });
});
