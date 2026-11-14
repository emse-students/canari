import type { AddressInfo } from 'net';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { ROUTE_PARAMS_GUARD } from '../common/route-params';
import { AnnouncementController } from './announcement.controller';
import { AnnouncementService } from './announcement.service';

/**
 * AN ANNOUNCEMENT ID THAT IS NOT A UUID IS A 400, AND THE SERVICE IS NEVER ASKED.
 *
 * `platform_announcement_seen.announcement_id` is a Postgres `uuid`, so the id must be judged before
 * the insert is built. The real controller and the real global guard, over HTTP; the session guard
 * is replaced by one that counts, to show the declaration is read BEFORE it.
 */
describe('POST users/me/announcement/:announcementId/seen', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const seen: unknown[][] = [];
  let sessionGuardRuns = 0;
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AnnouncementController],
      providers: [
        ROUTE_PARAMS_GUARD,
        {
          provide: AnnouncementService,
          useValue: {
            markSeen: (...args: unknown[]) => {
              seen.push(args);
              return Promise.resolve();
            },
          },
        },
      ],
    })
      .overrideGuard(NginxAuthGuard)
      .useValue({
        canActivate: () => {
          sessionGuardRuns += 1;
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    app?.getHttpServer().closeAllConnections();
    await app?.close();
  });

  beforeEach(() => {
    seen.length = 0;
    sessionGuardRuns = 0;
  });

  const post = (id: string) =>
    fetch(`${base}/users/me/announcement/${id}/seen`, {
      method: 'POST',
      headers: { 'x-user-id': 'Alice' },
    });

  it.each(['not-a-uuid', '42', `${ID}0`])(
    'refuses %s with a 400 naming the parameter',
    async (id) => {
      const res = await post(id);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain('"announcementId"');
      expect(seen).toEqual([]);
      expect(sessionGuardRuns).toBe(0);
    }
  );

  it('lets a uuid through to the session guard, then to the service', async () => {
    const res = await post(ID);
    expect(res.status).toBe(201);
    expect(sessionGuardRuns).toBe(1);
    expect(seen).toEqual([['alice', ID]]);
  });
});
