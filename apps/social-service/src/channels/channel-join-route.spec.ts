import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHmac } from 'crypto';
import type { AddressInfo } from 'net';
import { ChannelService } from './channel.service';
import { ChannelsController } from './channels.controller';

/**
 * A community is entered through an invite link or an invitation from a member who holds the
 * permission - and through nothing else. Membership is what entitles a device to the community's
 * key-distribution group (`isDistributionGroupEntitled`), so a route that writes a membership row
 * is a grant of every public salon's seeds, and it must check what those two doors check.
 *
 * `POST /channels/:channelId/members/join` was left from the channels MVP with no caller in any
 * client. It is deleted rather than kept, and this file asserts its absence over HTTP -
 * a real Nest application, the real guard, a valid signed caller - so a re-introduced handler
 * fails here and not in production. The neighbouring invite route is the control: the same
 * request shape on a registered path reaches its handler, so the 404 is the route's absence and
 * not the harness refusing everything.
 */

const SECRET = 'channel-join-route-spec-secret';
const USER = 'caller-user';

/** The per-minute token nginx mints, computed the way `verifyInternalToken` checks it. */
function internalToken(userId: string): string {
  const minute = Math.floor(Date.now() / 60000);
  return createHmac('sha256', SECRET).update(`${userId}:${minute}`).digest('hex');
}

describe('POST /api/channels/:channelId/members/join', () => {
  let app: INestApplication;
  let base: string;
  const service = {
    joinChannel: jest.fn().mockResolvedValue({ success: true }),
    inviteToChannel: jest.fn().mockResolvedValue({ success: true }),
  };
  const previousSecret = process.env.INTERNAL_SHARED_SECRET;

  beforeAll(async () => {
    process.env.INTERNAL_SHARED_SECRET = SECRET;

    @Module({
      controllers: [ChannelsController],
      providers: [{ provide: ChannelService, useValue: service }],
    })
    class RouteOnlyModule {}

    app = await NestFactory.create(RouteOnlyModule, { logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
    if (previousSecret === undefined) delete process.env.INTERNAL_SHARED_SECRET;
    else process.env.INTERNAL_SHARED_SECRET = previousSecret;
  });

  /** A POST signed exactly as nginx signs it for `USER`. */
  function signedPost(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': USER,
        'x-internal-token': internalToken(USER),
      },
      body: JSON.stringify(body),
    });
  }

  it('is not a route: a signed-in caller gets 404 and no membership is written', async () => {
    const res = await signedPost('/api/channels/some-channel/members/join', {});

    expect(res.status).toBe(404);
    expect(service.joinChannel).not.toHaveBeenCalled();
  });

  it('control: the invite route beside it still reaches its handler with the same caller', async () => {
    const res = await signedPost('/api/channels/some-channel/members/invite', {
      targetUserId: 'someone-else',
    });

    expect(res.status).toBe(201);
    expect(service.inviteToChannel).toHaveBeenCalledTimes(1);
  });
});
