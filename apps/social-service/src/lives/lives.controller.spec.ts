import { HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Readable } from 'stream';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { LiveEnabledGuard, isLiveEnabled } from './live-enabled.guard';
import { LIVE_SEGMENT_MAX_BYTES } from './live.constants';
import { LivesController } from './lives.controller';
import type { LivesService } from './lives.service';
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
      expect(await statusOf(() => new LiveEnabledGuard().canActivate())).toBe(HttpStatus.NOT_FOUND);
    }
    process.env.LIVE_ENABLED = 'true';
    expect(new LiveEnabledGuard().canActivate()).toBe(true);
  });

  it('guards the whole controller, the switch BEFORE the account check', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, LivesController)).toEqual([
      LiveEnabledGuard,
      NginxAuthGuard,
    ]);
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

describe('LivesController', () => {
  const ingest = jest.fn().mockResolvedValue({ index: 0 });
  const manifest = jest.fn().mockResolvedValue({});
  const controller = new LivesController({ ingest, manifest } as unknown as LivesService);
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
});
