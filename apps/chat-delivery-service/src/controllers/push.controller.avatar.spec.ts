/// <reference types="jest" />

import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PushController } from './push.controller';
import { PushToken } from '../entities/push-token.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { GroupMember } from '../entities/group-member.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MessagingService } from '../services/messaging.service';

/**
 * `GET /mls/push/avatar/:targetUserId` - ONE `[PUSH_AVATAR]` line per request, whatever happened.
 * Before it, a 502/503/timeout/403 left no trace in either service. The assertions pin the outcome
 * vocabulary, the level (info for served/absent, warn otherwise) and that the target id is
 * truncated and no secret or image ever reaches the line.
 */
describe('PushController - GET mls/push/avatar/:targetUserId', () => {
  let controller: PushController;
  let info: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;

  const SECRET = 'the-push-secret';
  const TARGET = '0123456789abcdef-full-user-id';
  const pushTokenRepo = {
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const emptyRepo = () => ({ findOne: jest.fn(), find: jest.fn(), save: jest.fn() });

  const makeRes = () => {
    const res: Record<string, jest.Mock> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.set = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    return res;
  };
  const call = (auth = `PushSecret ${SECRET}`, device = 'dev-1') => {
    const res = makeRes();
    const p = controller.getAvatarForPush(auth, 'requester-1', device, TARGET, res as never);
    return { p, res };
  };
  const lines = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0]));

  beforeEach(async () => {
    jest.clearAllMocks();
    info = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    pushTokenRepo.findOne.mockResolvedValue({
      pushSecret: crypto.createHash('sha256').update(SECRET).digest('hex'),
    });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PushController],
      providers: [
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(QueuedMessage), useValue: emptyRepo() },
        { provide: getRepositoryToken(KeyPackage), useValue: emptyRepo() },
        { provide: getRepositoryToken(GroupMember), useValue: emptyRepo() },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: MessagingService, useValue: {} as unknown as MessagingService },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HeaderAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(PushController);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
    fetchSpy.mockRestore();
  });

  it('served: info line, truncated target, device presence', async () => {
    fetchSpy.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const { p } = call();
    await p;
    const [line] = lines(info).filter((l) => l.startsWith('[PUSH_AVATAR]'));
    expect(line).toMatch(
      /^\[PUSH_AVATAR\] outcome=served status=200 ms=\d+ device=true target=01234567$/
    );
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain(TARGET);
    expect(warn).not.toHaveBeenCalled();
  });

  it('absent: core 404 is forwarded and logged at info', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    const { p, res } = call();
    await p;
    expect(res.status).toHaveBeenCalledWith(404);
    expect(lines(info).filter((l) => l.startsWith('[PUSH_AVATAR]'))).toEqual([
      expect.stringContaining('outcome=absent status=404'),
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('unavailable: core 502 is forwarded and logged at warn', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 502 }));
    const { p, res } = call();
    await p;
    expect(res.status).toHaveBeenCalledWith(502);
    expect(lines(warn)).toEqual([expect.stringContaining('outcome=unavailable status=502')]);
  });

  it('unreachable: a transport failure answers 503 and names its cause at warn', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { p, res } = call();
    await p;
    expect(res.status).toHaveBeenCalledWith(503);
    expect(lines(warn)).toEqual([
      expect.stringMatching(/outcome=unreachable status=503 .*detail=Error connect ECONNREFUSED/),
    ]);
  });

  it('rejected: a wrong secret still throws 403 and logs the outcome', async () => {
    const { p } = call('PushSecret wrong');
    await expect(p).rejects.toMatchObject({ status: 403 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines(warn).some((l) => l.includes('[PUSH_AVATAR] outcome=rejected status=403'))).toBe(
      true
    );
  });
});
