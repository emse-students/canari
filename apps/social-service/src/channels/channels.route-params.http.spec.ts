import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { createHmac } from 'crypto';
import type { AddressInfo } from 'net';
import { ROUTE_PARAMS_GUARD } from '../common/route-params';
import { ChannelService } from './channel.service';
import { ChannelsController } from './channels.controller';

/**
 * A channel, community, message or role id that is not a uuid is a 400 and reaches no handler; a
 * user id, a slug and an invite token are not uuids and pass as they came. The real controller and
 * the global guard `AppModule` registers, over HTTP.
 */

const SECRET = 'channels-route-params-spec-secret';
const USER = 'caller-user';
const ID = '5b1f0c2e-9a7d-4e36-8c41-2d7f6a9b0c13';

/** The per-minute token nginx mints, computed the way `verifyInternalToken` checks it. */
function internalToken(userId: string): string {
  const minute = Math.floor(Date.now() / 60000);
  return createHmac('sha256', SECRET).update(`${userId}:${minute}`).digest('hex');
}

describe('channel path ids are declared', () => {
  let app: INestApplication;
  let base: string;
  const previousSecret = process.env.INTERNAL_SHARED_SECRET;
  const calls: string[] = [];
  /** Every method of the service answers, and says it was reached. */
  const service = new Proxy(
    {},
    {
      get: (_target, name) =>
        typeof name === 'string' && name !== 'then'
          ? (..._args: unknown[]) => {
              calls.push(name);
              return Promise.resolve({ success: true });
            }
          : undefined,
    }
  );

  beforeAll(async () => {
    process.env.INTERNAL_SHARED_SECRET = SECRET;

    @Module({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [ChannelsController],
      providers: [ROUTE_PARAMS_GUARD, { provide: ChannelService, useValue: service }],
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

  beforeEach(() => {
    calls.length = 0;
  });

  /** A request signed exactly as nginx signs it for `USER`. */
  const signed = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-user-id': USER,
        'x-internal-token': internalToken(USER),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it.each([
    ['channelId', 'GET', '/api/channels/some-channel/members'],
    ['workspaceId', 'GET', '/api/channels/workspaces/some-community/members'],
    ['messageId', 'DELETE', `/api/channels/${ID}/messages/some-message`],
    ['roleId', 'GET', '/api/channels/roles/some-role/permissions'],
  ])(
    'a %s that is not a uuid is a 400 naming it, and no handler is reached',
    async (name, method, path) => {
      const res = await signed(method, path);

      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain(`"${name}"`);
      expect(calls).toEqual([]);
    }
  );

  it('control: the same routes with uuids reach their handlers', async () => {
    expect((await signed('GET', `/api/channels/${ID}/members`)).status).toBe(200);
    expect((await signed('GET', `/api/channels/workspaces/${ID}/members`)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('a user id, a slug and an invite token are not uuids and pass as they came', async () => {
    expect((await signed('DELETE', `/api/channels/${ID}/members/a-user-id`)).status).toBe(200);
    expect((await signed('GET', '/api/channels/workspaces/by-slug/bde')).status).toBe(200);
    expect((await signed('GET', '/api/channels/invites/some-token')).status).toBe(200);
    expect(calls).toHaveLength(3);
  });
});
