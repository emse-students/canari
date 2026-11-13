/**
 * The member's daily upload bound: what one member may upload in a rolling 24 hours, every class and
 * every upload route together (docs/wiki/backlog.d/p2-a-daily-upload-bound-per-member.md).
 *
 * Pinned, each because the opposite is a plausible mistake:
 *  - every upload records its size, whatever its class - the sum is read from the index;
 *  - the refusal is a 422 carrying a CODE (the status every released app stops on), and one WARN
 *    line with the member's day in it;
 *  - the bytes are RESERVED in the tick that checks them, and given back when the store refuses;
 *  - a refusal by the `chat-reel` budget leaves nothing reserved against the member's bound.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { CHAT_REEL_OVER_BUDGET, MEMBER_UPLOAD_OVER_BUDGET, MediaService } from './media.service';

type Entry = {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  retentionClass?: string;
  ownerId?: string;
  size?: number;
};

type ServiceInternals = {
  meta: { items: Record<string, Entry> };
  storage: Record<string, unknown>;
  logger: Record<'log' | 'debug' | 'warn' | 'error', (msg: string) => void>;
  persistMetadata: () => Promise<void>;
  uploadLocks: Map<string, Promise<void>>;
  memberUploadReservations?: Map<string, number>;
};

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY = 24 * 60 * 60 * 1000;

const stored = (
  ownerId: string,
  bytes: number,
  retentionClass?: string,
  ageMs = 60_000
): Entry => ({
  createdAt: Date.now() - ageMs,
  lastAccessAt: Date.now(),
  ownerId,
  size: bytes,
  ...(retentionClass ? { retentionClass } : {}),
});

/** A service with planted metadata, a recording storage stub and persistence disabled. */
function serviceWith(items: Record<string, Entry>) {
  const service = Object.create(MediaService.prototype) as MediaService;
  const put: number[] = [];
  const warned: string[] = [];
  const failPut = { value: false };
  const internals = service as unknown as ServiceInternals;
  internals.meta = { items };
  internals.storage = {
    // Yields first: the real store write is an await, the gap a concurrent upload slips through
    // when the bound is checked but not reserved.
    put: async (_id: string, _data: Buffer, size: number) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (failPut.value) throw new Error('store down');
      put.push(size);
    },
  };
  internals.logger = {
    log: () => {},
    debug: () => {},
    warn: (msg) => void warned.push(msg),
    error: () => {},
  };
  internals.uploadLocks = new Map();
  internals.persistMetadata = () => Promise.resolve();
  return { service, put, warned, failPut, internals };
}

describe("the member's daily upload bound (2 GB)", () => {
  it('records the size of an upload of any class', async () => {
    const items: Record<string, Entry> = {};
    const { service } = serviceWith(items);

    const ephemeral = await service.upload(Buffer.alloc(100), 'member', 'ephemeral');
    const unclassified = await service.upload(Buffer.alloc(200), 'member', undefined);

    expect(items[ephemeral].size).toBe(100);
    expect(items[unclassified].size).toBe(200);
  });

  it('refuses with a 422 and its code the upload that would cross it, and stores nothing', async () => {
    const { service, put } = serviceWith({ a: stored('member', 2 * GB - MB, 'ephemeral') });

    const refused = service.upload(Buffer.alloc(2 * MB), 'member', 'archive');

    await expect(refused).rejects.toBeInstanceOf(HttpException);
    await expect(refused).rejects.toMatchObject({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      response: { code: MEMBER_UPLOAD_OVER_BUDGET },
    });
    expect(put).toEqual([]);
  });

  it('accepts the upload that lands exactly on it', async () => {
    const { service, put } = serviceWith({ a: stored('member', 2 * GB - MB, 'ephemeral') });

    await service.upload(Buffer.alloc(MB), 'member', 'archive');

    expect(put).toEqual([MB]);
  });

  it("says the member's day in ONE warn line per refusal", async () => {
    const { service, warned } = serviceWith({
      a: stored('member', GB, 'ephemeral'),
      b: stored('member', GB, 'archive'),
    });

    await expect(service.upload(Buffer.alloc(10), 'member', undefined)).rejects.toMatchObject({
      response: { code: MEMBER_UPLOAD_OVER_BUDGET },
    });

    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('[MEMBER_UPLOAD_BUDGET]');
    expect(warned[0]).toContain(`2 uploads and ${2 * GB} bytes`);
    expect(warned[0]).toContain('10 more');
  });

  it("sums every class of the CALLER's last 24 hours, and nothing else", async () => {
    const { service, put } = serviceWith({
      // Somebody else's, the caller's own from two days ago, and one stored before sizes were kept.
      other: stored('someone-else', 2 * GB, 'ephemeral'),
      old: stored('member', 2 * GB, 'archive', 2 * DAY),
      unsized: { createdAt: Date.now(), lastAccessAt: Date.now(), ownerId: 'member' },
      // What counts: three classes of the caller, today.
      a: stored('member', GB, 'ephemeral'),
      b: stored('member', 512 * MB, 'reel'),
      c: stored('member', 511 * MB, undefined),
    });

    await service.upload(Buffer.alloc(MB), 'member', 'association');
    await expect(service.upload(Buffer.alloc(1), 'member', 'ephemeral')).rejects.toMatchObject({
      response: { code: MEMBER_UPLOAD_OVER_BUDGET },
    });

    expect(put).toEqual([MB]);
  });

  it('does not meter an upload that has no owner', async () => {
    const { service, put } = serviceWith({ a: stored('member', 2 * GB, 'ephemeral') });

    await service.upload(Buffer.alloc(MB), undefined, undefined);

    expect(put).toEqual([MB]);
  });
});

describe("the member's daily upload bound is RESERVED, not just checked", () => {
  it('lets exactly the uploads that fit through when they run CONCURRENTLY', async () => {
    const { service, put, internals } = serviceWith({
      a: stored('member', 2 * GB - 2 * MB, 'ephemeral'),
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.upload(Buffer.alloc(MB), 'member', 'ephemeral'))
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(put).toEqual([MB, MB]);
    expect(internals.memberUploadReservations?.size).toBe(0);
  });

  it('gives the bytes back when the store write fails', async () => {
    const { service, put, failPut, internals } = serviceWith({
      a: stored('member', 2 * GB - MB, 'ephemeral'),
    });
    failPut.value = true;
    await expect(service.upload(Buffer.alloc(MB), 'member', 'ephemeral')).rejects.toThrow(
      'store down'
    );
    expect(internals.memberUploadReservations?.size).toBe(0);

    failPut.value = false;
    await service.upload(Buffer.alloc(MB), 'member', 'ephemeral');

    expect(put).toEqual([MB]);
  });

  it('reserves nothing for an upload the chat-reel budget refuses', async () => {
    const { service, internals } = serviceWith({
      a: {
        ...stored('member', 499 * MB, 'chat-reel'),
      },
    });

    await expect(service.upload(Buffer.alloc(2 * MB), 'member', 'chat-reel')).rejects.toMatchObject(
      { response: { code: CHAT_REEL_OVER_BUDGET } }
    );

    expect(internals.memberUploadReservations?.size).toBe(0);
  });

  it('puts back a reservation granted before a restart without judging it again', () => {
    const { service, internals } = serviceWith({ a: stored('member', 2 * GB, 'ephemeral') });

    const release = service.reserveUploadBudget('ephemeral', 'member', MB, true);

    expect(internals.memberUploadReservations?.get('member')).toBe(MB);
    release();
    release();
    expect(internals.memberUploadReservations?.size).toBe(0);
  });
});
