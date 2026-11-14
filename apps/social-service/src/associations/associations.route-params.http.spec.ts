import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { createHmac } from 'crypto';
import type { AddressInfo } from 'net';
import { ROUTE_PARAMS_GUARD } from '../common/route-params';
import { AccountBellsService } from '../follows/account-bells.service';
import { FollowsService } from '../follows/follows.service';
import { SpacesService } from '../spaces/spaces.service';
import { UserProfileService } from './user-profile.service';
import { UserTagService } from '../users/user-tag.service';
import { AssociationsController } from './associations.controller';
import { AssociationsService } from './associations.service';
import { PartnershipsService } from './partnerships.service';
import { ProductsService } from './products.service';

/**
 * A MALFORMED ASSOCIATION ID IS A 400 BEFORE ANY GUARD ASKS THE DATABASE ABOUT IT.
 *
 * `GlobalAdminOrAssociationRoleGuard` reads `:id` and asks the service whether the caller may act
 * on that association. Nest runs guards before pipes, so only something that runs before THAT guard
 * can refuse a malformed id: the global `RouteParamsGuard`. This boots the real controller, the
 * real guards and the same global provider `AppModule` registers, over HTTP, and asserts the order
 * by what the role guard's questions saw: nothing.
 */

const SECRET = 'route-params-http-spec-secret';
const USER = 'caller-user';
const ASSOCIATION = '0c0f6f0e-2f8e-4d57-9d0b-3a1d5b6c7e8f';

/** The per-minute token nginx mints, computed the way `verifyInternalToken` checks it. */
function internalToken(userId: string): string {
  const minute = Math.floor(Date.now() / 60000);
  return createHmac('sha256', SECRET).update(`${userId}:${minute}`).digest('hex');
}

describe('a malformed path id is refused before the association role guard', () => {
  let app: INestApplication;
  let base: string;
  const previousSecret = process.env.INTERNAL_SHARED_SECRET;

  /** Every question the role guard can ask the database, through the service. */
  const service = {
    mayAct: jest.fn().mockResolvedValue(true),
    isMember: jest.fn().mockResolvedValue(true),
    isAssociationSuperAdminOf: jest.fn().mockResolvedValue(false),
    findBySlug: jest.fn().mockResolvedValue({ id: ASSOCIATION, slug: 'bde' }),
    withPaymentsReady: jest.fn(async (rows: unknown[]) => rows),
  };
  const tags = { listByAssoc: jest.fn().mockResolvedValue([]) };
  const follows = { isFollowing: jest.fn().mockResolvedValue(false) };

  beforeAll(async () => {
    process.env.INTERNAL_SHARED_SECRET = SECRET;

    @Module({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [AssociationsController],
      providers: [
        ROUTE_PARAMS_GUARD,
        { provide: AssociationsService, useValue: service },
        { provide: UserTagService, useValue: tags },
        { provide: FollowsService, useValue: follows },
        { provide: ProductsService, useValue: {} },
        { provide: PartnershipsService, useValue: {} },
        { provide: UserProfileService, useValue: {} },
        { provide: AccountBellsService, useValue: {} },
        { provide: SpacesService, useValue: {} },
      ],
    })
    class RouteOnlyModule {}

    app = await NestFactory.create(RouteOnlyModule, { logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    // Sockets a test left idle or half-read must not outlive the worker (open handle at teardown).
    app?.getHttpServer().closeAllConnections();
    await app?.close();
    if (previousSecret === undefined) delete process.env.INTERNAL_SHARED_SECRET;
    else process.env.INTERNAL_SHARED_SECRET = previousSecret;
  });

  beforeEach(() => jest.clearAllMocks());

  /** A GET signed exactly as nginx signs it for `USER`. */
  const signedGet = (path: string) =>
    fetch(`${base}${path}`, {
      headers: { 'x-user-id': USER, 'x-internal-token': internalToken(USER) },
    });

  it.each(['not-a-uuid', '0c0f6f0e-2f8e-4d57-9d0b', '42'])(
    'a role-guarded route answers 400 for "%s", and the role guard asked nothing',
    async (id) => {
      const res = await signedGet(`/api/associations/${id}/tags`);

      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain('"id"');
      expect(service.mayAct).not.toHaveBeenCalled();
      expect(service.isMember).not.toHaveBeenCalled();
      expect(service.isAssociationSuperAdminOf).not.toHaveBeenCalled();
      expect(tags.listByAssoc).not.toHaveBeenCalled();
    }
  );

  it('control: the same route with a uuid reaches the role guard, then its handler', async () => {
    const res = await signedGet(`/api/associations/${ASSOCIATION}/tags`);

    expect(res.status).toBe(200);
    expect(service.mayAct).toHaveBeenCalledWith(
      USER,
      ASSOCIATION,
      expect.anything(),
      expect.anything()
    );
    expect(tags.listByAssoc).toHaveBeenCalledTimes(1);
  });

  it('a route with no role guard answers 400 too, and its handler is not reached', async () => {
    const res = await signedGet('/api/associations/not-a-uuid/follow-status');

    expect(res.status).toBe(400);
    expect(follows.isFollowing).not.toHaveBeenCalled();
  });

  it('the refusal comes before authentication is asked: an unsigned malformed request is a 400', async () => {
    const res = await fetch(`${base}/api/associations/not-a-uuid/tags`);

    expect(res.status).toBe(400);
  });

  it('a parameter declared opaque passes as it came: a slug is a word', async () => {
    const res = await signedGet('/api/associations/slug/bde');

    expect(res.status).toBe(200);
    expect(service.findBySlug).toHaveBeenCalledWith('bde');
  });
});
