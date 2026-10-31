import { HttpStatus, Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Readable } from 'stream';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { LiveEnabledGuard, isLiveEnabled } from './live-enabled.guard';
import { guardContext } from './live-guard-context.test-helper';
import { LIVE_SEGMENT_MAX_BYTES } from './live.constants';
import { LivesController } from './lives.controller';
import type { LivesService } from './lives.service';
import type { AssociationsService } from '../associations/associations.service';
import type { LiveChatService } from './live-chat.service';
import { readBoundedBody } from './read-bounded-body';

/** A request whose body is `chunks`, with `content-length` when given. */
function request(chunks: Buffer[], contentLength?: number) {
  const stream = Readable.from(chunks) as Readable & { headers: Record<string, string> };
  stream.headers = contentLength === undefined ? {} : { 'content-length': String(contentLength) };
  return stream;
}

async function statusOf(p: Promise<unknown> | (() => unknown)): Promise<number> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return (e as { getStatus: () => number }).getStatus();
  }
  return HttpStatus.OK;
}

/** A DataSource whose `platform_config` answers `rows` (or throws `error`) - the one read the guard makes. */
function platformDb(rows: unknown[] | Error) {
  const query = jest.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  return { db: { manager: { query } } as unknown as DataSource, query };
}

describe('the live switch (LIVE_ENABLED)', () => {
  const saved = process.env.LIVE_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.LIVE_ENABLED;
    else process.env.LIVE_ENABLED = saved;
  });

  it('is OFF unless the value is exactly "true" - unset, empty, "1" and "TRUE" are all off', async () => {
    for (const value of [undefined, '', '1', 'TRUE', 'false']) {
      if (value === undefined) delete process.env.LIVE_ENABLED;
      else process.env.LIVE_ENABLED = value;
      expect(isLiveEnabled()).toBe(false);
      // The deploy lock is asked FIRST: a closed estate never reads the database, even with lives on.
      const { db, query } = platformDb([{ lives_mode: 'on' }]);
      expect(await statusOf(() => new LiveEnabledGuard(db).canActivate(guardContext()))).toBe(
        HttpStatus.NOT_FOUND
      );
      expect(query).not.toHaveBeenCalled();
    }
    process.env.LIVE_ENABLED = 'true';
    await expect(
      new LiveEnabledGuard(platformDb([{ lives_mode: 'on' }]).db).canActivate(guardContext())
    ).resolves.toBe(true);
  });

  it('guards the whole controller, the switch BEFORE the account check', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, LivesController)).toEqual([
      LiveEnabledGuard,
      NginxAuthGuard,
    ]);
  });
});

/**
 * THE RUNTIME KILL SWITCH (`platform_config.lives_mode`, migration 015 in core-service), ANDed with
 * the deploy lock. Every `/api/lives` route sits behind this one guard (asserted above and in
 * live-chat.service.spec.ts), so these cases are the refusal of each route.
 */
describe('the live kill switch (platform_config.lives_mode)', () => {
  const saved = process.env.LIVE_ENABLED;
  beforeEach(() => {
    process.env.LIVE_ENABLED = 'true';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LIVE_ENABLED;
    else process.env.LIVE_ENABLED = saved;
  });

  it('answers 404 while the switch is off, the answer of the deploy lock', async () => {
    const { db, query } = platformDb([{ lives_mode: 'off' }]);
    expect(await statusOf(() => new LiveEnabledGuard(db).canActivate(guardContext()))).toBe(
      HttpStatus.NOT_FOUND
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT lives_mode FROM platform_config')
    );
  });

  it('reads the database on EVERY request, so a flip holds from the next one', async () => {
    const answers = [[{ lives_mode: 'on' }], [{ lives_mode: 'off' }]];
    const query = jest.fn(async () => answers.shift());
    const guard = new LiveEnabledGuard({ manager: { query } } as unknown as DataSource);
    await expect(guard.canActivate(guardContext())).resolves.toBe(true);
    expect(await statusOf(() => guard.canActivate(guardContext()))).toBe(HttpStatus.NOT_FOUND);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('answers 404 when the row is missing, and says so at error', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    expect(
      await statusOf(() => new LiveEnabledGuard(platformDb([]).db).canActivate(guardContext()))
    ).toBe(HttpStatus.NOT_FOUND);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('MISSING'));
    error.mockRestore();
  });

  it.each(['ON', 'true', 'audio', '', null])(
    'refuses (throws, never opens) on an unknown value %p',
    async (value) => {
      await expect(
        new LiveEnabledGuard(platformDb([{ lives_mode: value }]).db).canActivate(guardContext())
      ).rejects.toThrow(/unknown value/);
    }
  );

  it('refuses when the read fails - a switch that cannot be read is not read as open', async () => {
    await expect(
      new LiveEnabledGuard(platformDb(new Error('connection lost')).db).canActivate(guardContext())
    ).rejects.toThrow('connection lost');
  });
});

describe('a segment body', () => {
  it('is refused before reading when its declared length is over the bound', async () => {
    const req = request([Buffer.alloc(1)], LIVE_SEGMENT_MAX_BYTES + 1);
    expect(await statusOf(readBoundedBody(req, LIVE_SEGMENT_MAX_BYTES))).toBe(
      HttpStatus.PAYLOAD_TOO_LARGE
    );
  });

  it('is refused as soon as an undeclared body grows past the bound', async () => {
    const req = request([Buffer.alloc(6), Buffer.alloc(6)]);
    expect(await statusOf(readBoundedBody(req, 10))).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
  });

  it('is refused when empty, and read whole otherwise', async () => {
    expect(await statusOf(readBoundedBody(request([]), 10))).toBe(HttpStatus.BAD_REQUEST);
    await expect(
      readBoundedBody(request([Buffer.from('ab'), Buffer.from('cd')], 4), 10)
    ).resolves.toEqual(Buffer.from('abcd'));
  });
});

const MODERATOR = 'm'.repeat(64);

describe('LivesController', () => {
  const ingest = jest.fn().mockResolvedValue({ index: 0 });
  const manifest = jest.fn().mockResolvedValue({ liveId: 'm' });
  const read = jest.fn().mockResolvedValue({ messages: [] });
  const cut = jest.fn().mockResolvedValue({ newlyCut: true });
  const rulesStatus = jest.fn().mockResolvedValue({ version: 1 });
  /** The posts' one moderator predicate, faked: only `MODERATOR` holds `MODERATE` in a BDE. */
  const isContentModerator = jest.fn(
    async (userId: string, opts?: { isGlobalAdmin?: boolean }) =>
      opts?.isGlobalAdmin === true || userId === MODERATOR
  );
  const controller = new LivesController(
    { ingest, manifest, cut, rulesStatus } as unknown as LivesService,
    { isContentModerator } as unknown as AssociationsService,
    { read } as unknown as LiveChatService
  );
  const LIVE = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => jest.clearAllMocks());

  it('accepts a decimal index only, and hands the caller in lower case', async () => {
    for (const bad of ['', '-1', '0x10', '1e3', '1.5', '1234567']) {
      const req = request([Buffer.from('x')]) as never;
      expect(await statusOf(controller.putSegment(LIVE, bad, 'A'.repeat(64), req))).toBe(
        HttpStatus.BAD_REQUEST
      );
    }
    expect(ingest).not.toHaveBeenCalled();
    await controller.putSegment(LIVE, '7', 'A'.repeat(64), request([Buffer.from('x')]) as never);
    expect(ingest).toHaveBeenCalledWith('a'.repeat(64), LIVE, 7, Buffer.from('x'));
  });

  it('reads `from` as an index, and its absence as "the newest window"', async () => {
    await controller.manifest(LIVE, 'b'.repeat(64));
    expect(manifest).toHaveBeenLastCalledWith('b'.repeat(64), LIVE, undefined);
    await controller.manifest(LIVE, 'b'.repeat(64), '12');
    expect(manifest).toHaveBeenLastCalledWith('b'.repeat(64), LIVE, 12);
    expect(await statusOf(controller.manifest(LIVE, 'b'.repeat(64), 'x'))).toBe(
      HttpStatus.BAD_REQUEST
    );
  });

  describe('the staff cut: WHO may (the posts moderation predicate)', () => {
    const body = { reason: 'harassment' };

    it.each([
      ['a member', 'b'.repeat(64), undefined],
      ['the broadcaster', 'a'.repeat(64), undefined],
      ['a member sending x-global-admin: false', 'c'.repeat(64), 'false'],
      ['a member sending a misspelt admin header', 'c'.repeat(64), 'TRUE'],
    ])(
      'refuses %s with 403 LIVE_CUT_FORBIDDEN, before the live is looked up',
      async (_who, userId, admin) => {
        await expect(controller.cut(LIVE, userId, admin, body)).rejects.toMatchObject({
          status: HttpStatus.FORBIDDEN,
          response: { code: 'LIVE_CUT_FORBIDDEN' },
        });
        expect(cut).not.toHaveBeenCalled();
      }
    );

    it('lets a BDE moderator and a platform admin cut, the caller and the id in lower case', async () => {
      await controller.cut(LIVE.toUpperCase(), MODERATOR.toUpperCase(), undefined, body);
      expect(cut).toHaveBeenLastCalledWith(MODERATOR, LIVE, body);
      await controller.cut(LIVE, 'd'.repeat(64), 'true', body);
      expect(cut).toHaveBeenLastCalledWith('d'.repeat(64), LIVE, body);
      expect(isContentModerator).toHaveBeenLastCalledWith('d'.repeat(64), { isGlobalAdmin: true });
    });
  });

  it('answers the caller its first-live rules standing', async () => {
    await controller.rules('A'.repeat(64));
    expect(rulesStatus).toHaveBeenCalledWith('a'.repeat(64));
  });

  it('adds the chat block ONLY with chat=1, after the manifest let the viewer watch (WP-L6, C3)', async () => {
    await expect(controller.manifest(LIVE, 'b'.repeat(64))).resolves.toEqual({ liveId: 'm' });
    expect(read).not.toHaveBeenCalled();

    await expect(controller.manifest(LIVE, 'B'.repeat(64), undefined, '1')).resolves.toEqual({
      liveId: 'm',
      chat: { messages: [] },
    });
    expect(read).toHaveBeenLastCalledWith('b'.repeat(64), LIVE, {
      messagesAfter: undefined,
      reactionsAfter: undefined,
    });
    await controller.manifest(LIVE, 'b'.repeat(64), '3', '1', '41', '0');
    expect(read).toHaveBeenLastCalledWith('b'.repeat(64), LIVE, {
      messagesAfter: 41,
      reactionsAfter: 0,
    });
  });

  it('refuses a malformed chat cursor BEFORE the manifest renews a seat', async () => {
    for (const bad of ['', '-1', '1.5', '0x1', '1234567890']) {
      expect(await statusOf(controller.manifest(LIVE, 'b'.repeat(64), undefined, '1', bad))).toBe(
        HttpStatus.BAD_REQUEST
      );
      expect(
        await statusOf(controller.manifest(LIVE, 'b'.repeat(64), undefined, '1', '0', bad))
      ).toBe(HttpStatus.BAD_REQUEST);
    }
    expect(manifest).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
