import { BadRequestException, Logger } from '@nestjs/common';
import { UsersController } from './users.controller';
import type { AvatarOutcome, AvatarService } from './avatar.service';
import type { UsersService } from './users.service';
import type { UserBlocksService } from './user-blocks.service';

/**
 * `GET /users/:id/avatar` - ONE `[AVATAR]` line per request, whatever the outcome. Status codes are
 * unchanged by it; the assertions pin the vocabulary, the level (info for served/absent, warn for
 * the rest) and the 8-character target truncation.
 */
describe('GET /users/:id/avatar logging', () => {
  const ID = 'abcdef0123456789';
  let info: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    info = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
  });

  async function run(fetchUserAvatar: () => Promise<AvatarOutcome>) {
    const controller = new UsersController(
      {} as UsersService,
      { fetchUserAvatar } as unknown as AvatarService,
      {} as UserBlocksService
    );
    const res = { set: jest.fn(), status: jest.fn(), end: jest.fn(), send: jest.fn() };
    res.status.mockReturnValue(res);
    await controller.getAvatar(ID, res as never);
    return res;
  }

  it('served: info, 200, truncated target', async () => {
    await run(async () => ({ kind: 'image', body: Buffer.from([1]), contentType: 'image/png' }));
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(
      /^\[AVATAR\] outcome=served status=200 ms=\d+ target=abcdef01$/
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('absent: info, 404', async () => {
    const res = await run(async () => ({ kind: 'absent' }));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(String(info.mock.calls[0][0])).toContain('outcome=absent status=404');
    expect(warn).not.toHaveBeenCalled();
  });

  it('unavailable: warn, 502', async () => {
    const res = await run(async () => ({ kind: 'unavailable' }));
    expect(res.status).toHaveBeenCalledWith(502);
    expect(String(warn.mock.calls[0][0])).toContain('outcome=unavailable status=502');
    expect(info).not.toHaveBeenCalled();
  });

  it('disabled: warn, 404', async () => {
    const res = await run(async () => ({ kind: 'disabled' }));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(String(warn.mock.calls[0][0])).toContain('outcome=disabled status=404');
  });

  it('rejected: a malformed id still throws 400 and logs', async () => {
    await expect(
      run(async () => {
        throw new BadRequestException('Invalid user ID');
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(String(warn.mock.calls[0][0])).toContain('outcome=rejected status=400');
  });
});
