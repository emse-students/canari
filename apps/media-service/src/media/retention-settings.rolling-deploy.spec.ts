/**
 * THE RETENTION DURATIONS ACROSS A ROLLING DEPLOY (2026-11-15, the `1.7.0-alpha.1` deploy on dev;
 * docs/wiki/retention-settings.md).
 *
 * The ordering reproduced: media-service boots beside the OLD social-service, which has no relay
 * route, so its boot read answers 404. The NEW social-service then notifies - but a read made in
 * answer goes through the mesh, which still routes to the old replica (the new one is not listening
 * yet, and enters the mesh's targets only once healthy), and answers 404 again. Before the fix the
 * holder stayed empty and conversation uploads were refused. Pinned:
 *  - the notice CARRIES the durations, and an empty holder holds them with no read at all;
 *  - handed values never replace held ones - a held value changes only by a read, ordered as before;
 *  - a bare notice (core-service's) still reads;
 *  - the route parses the body and refuses a malformed one before touching the holder.
 */
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { MediaController } from './media.controller';
import type { MediaService } from './media.service';
import {
  MediaRetentionHolder,
  handedRetention,
  mediaRetention,
  type MediaRetentionDays,
} from './retention-settings';

const values = (chatReelDays: number, idleFileDays: number): MediaRetentionDays => ({
  chatReelDays,
  idleFileDays,
});
const logs = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
/** The retiring social-service replica, reached through the mesh: it predates the relay route. */
const oldReplica = () =>
  jest.fn<Promise<MediaRetentionDays>, []>(() =>
    Promise.reject(new ServiceUnavailableException('social-service answered 404'))
  );

describe('a rolling deploy: the old replica answers 404 while the new one notifies', () => {
  it('holds the durations the notice hands over, with no read through the mesh', async () => {
    let now = 1_000_000;
    const read = oldReplica();
    const logger = logs();
    const holder = new MediaRetentionHolder(read, logger, () => now);

    expect(await holder.refresh('boot')).toBe(false);
    expect(() => holder.require()).toThrow(ServiceUnavailableException);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('nothing is held'));

    await Promise.resolve();
    // The boot read, and the one the refused upload asked for - both answered 404.
    expect(read).toHaveBeenCalledTimes(2);

    now += 11_000;
    expect(await holder.notice(values(30, 90))).toBe(true);
    expect(holder.require()).toEqual(values(30, 90));
    // The notice's values were not re-asked of the replica that answers 404.
    expect(read).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('readable again (handed) after 11 s: 1 upload(s) refused meanwhile')
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a bare notice in the same ordering still finds nothing: the values must travel with it', async () => {
    const holder = new MediaRetentionHolder(oldReplica(), logs());
    await holder.refresh('boot');
    expect(await holder.notice(null)).toBe(false);
    expect(holder.snapshot()).toBeNull();
  });
});

describe('handed values never replace held ones', () => {
  it('once anything is held, a notice with values is a read, and the read decides', async () => {
    const read = jest
      .fn<Promise<MediaRetentionDays>, []>()
      .mockResolvedValueOnce(values(14, 60))
      .mockResolvedValueOnce(values(7, 45));
    const holder = new MediaRetentionHolder(read, logs());

    await holder.refresh('boot');
    // A snapshot taken before an admin change committed: holding it would overwrite the change.
    expect(await holder.notice(values(30, 90))).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(holder.require()).toEqual(values(7, 45));
  });

  it('and a failed read then keeps what was held, never the snapshot', async () => {
    const read = jest
      .fn<Promise<MediaRetentionDays>, []>()
      .mockResolvedValueOnce(values(14, 60))
      .mockRejectedValue(new ServiceUnavailableException('social-service answered 404'));
    const holder = new MediaRetentionHolder(read, logs());

    await holder.refresh('boot');
    expect(await holder.notice(values(30, 90))).toBe(false);
    expect(holder.require()).toEqual(values(14, 60));
  });
});

describe('handedRetention - the notice body', () => {
  it('is null for a bare notice', () => {
    expect(handedRetention(undefined)).toBeNull();
    expect(handedRetention({})).toBeNull();
  });

  it('reads both durations', () => {
    expect(handedRetention({ chatReelDays: 30, idleFileDays: 90 })).toEqual(values(30, 90));
  });

  it.each([
    { chatReelDays: 30 },
    { idleFileDays: 90 },
    { chatReelDays: 0, idleFileDays: 90 },
    { chatReelDays: 30, idleFileDays: 1.5 },
    { chatReelDays: '30', idleFileDays: 90 },
  ])('refuses %p with a 400', (body) => {
    expect(() => handedRetention(body)).toThrow(BadRequestException);
  });
});

describe('POST media/internal/retention-changed', () => {
  const SECRET = 'retention-secret';
  const prev = process.env.INTERNAL_SECRET;
  beforeAll(() => {
    process.env.INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = prev;
  });
  const controller = () => new MediaController({} as MediaService, {} as never, {} as never);

  it('hands the body to the holder, and a bare one as null', async () => {
    const notice = jest.spyOn(mediaRetention, 'notice').mockResolvedValue(true);
    await controller().retentionChanged(SECRET, { chatReelDays: 30, idleFileDays: 90 });
    expect(notice).toHaveBeenLastCalledWith(values(30, 90));
    await controller().retentionChanged(SECRET, {});
    expect(notice).toHaveBeenLastCalledWith(null);
    notice.mockRestore();
  });

  it('refuses a malformed body before touching the holder', async () => {
    const notice = jest.spyOn(mediaRetention, 'notice');
    await expect(
      controller().retentionChanged(SECRET, { chatReelDays: 30 })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(notice).not.toHaveBeenCalled();
    notice.mockRestore();
  });
});
