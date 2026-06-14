import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Inject,
  BadRequestException,
  UseGuards,
  Headers,
  HttpCode,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import {
  sanitizeQueryValue,
  parsePositiveInt,
  hashJoinToken,
  assertCallerOwnsUserId,
} from '../utils/sanitize';
import {
  SyncSessionState,
  SyncManifestPayload,
  SyncSerializedChunk,
  sanitizeSyncManifest,
  sanitizeSerializedChunks,
  computeManifestDiff,
} from '../utils/sync-types';

/** QR-code based device-to-device sync session management. */
@Controller()
export class SyncController {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  /** Ensures the authenticated user matches the body `userId`. */
  private assertBodyUser(
    headerUserId: string | undefined,
    bodyUserId: string,
  ): string {
    const safeBodyUserId = sanitizeQueryValue(bodyUserId, 'userId');
    assertCallerOwnsUserId(
      headerUserId,
      undefined,
      safeBodyUserId,
      'Cannot act on behalf of another user',
    );
    return safeBodyUserId;
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/sync/session/start')
  /** Creates a new QR sync session (offer side) and returns the session ID. */
  async startSyncSession(
    @Body()
    body: {
      userId: string;
      deviceId: string;
      offerPublicKey: string;
      ttlSeconds?: number;
    },
    @Headers('x-user-id') headerUserId?: string,
  ) {
    const userId = this.assertBodyUser(headerUserId, body.userId);
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const offerPublicKey = sanitizeQueryValue(
      body.offerPublicKey,
      'offerPublicKey',
    );

    const ttlSeconds = Math.min(parsePositiveInt(body.ttlSeconds, 180), 900);
    const createdAt = Date.now();
    const expiresAt = createdAt + ttlSeconds * 1000;
    const sessionId = uuidv4();
    const joinToken = crypto.randomBytes(24).toString('base64url');

    const session: SyncSessionState = {
      sessionId,
      userId,
      offerDeviceId: deviceId,
      offerPublicKey,
      joinTokenHash: hashJoinToken(joinToken),
      state: 'waiting_join',
      createdAt,
      expiresAt,
    };

    const baseKey = `sync:session:${sessionId}`;
    await this.redis.set(baseKey, JSON.stringify(session), 'EX', ttlSeconds);

    return {
      sessionId,
      joinToken,
      expiresAt,
      qrPayload: {
        sessionId,
        joinToken,
        userId,
      },
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/sync/session/join')
  /** Joins an existing QR sync session (answer side) and stores the answer key. */
  async joinSyncSession(
    @Body()
    body: {
      sessionId: string;
      joinToken: string;
      userId: string;
      deviceId: string;
      answerPublicKey: string;
    },
    @Headers('x-user-id') headerUserId?: string,
  ) {
    const sessionId = sanitizeQueryValue(body.sessionId, 'sessionId');
    const joinToken = sanitizeQueryValue(body.joinToken, 'joinToken');
    const userId = this.assertBodyUser(headerUserId, body.userId);
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const answerPublicKey = sanitizeQueryValue(
      body.answerPublicKey,
      'answerPublicKey',
    );

    const baseKey = `sync:session:${sessionId}`;
    const raw = await this.redis.get(baseKey);
    if (!raw)
      throw new BadRequestException('Sync session not found or expired');

    const session = JSON.parse(raw) as SyncSessionState;
    if (session.userId !== userId) {
      throw new BadRequestException('Session user mismatch');
    }
    if (session.offerDeviceId === deviceId) {
      throw new BadRequestException('Cannot join from the same device');
    }
    if (hashJoinToken(joinToken) !== session.joinTokenHash) {
      throw new BadRequestException('Invalid join token');
    }

    session.answerDeviceId = deviceId;
    session.answerPublicKey = answerPublicKey;
    session.state = 'joined';

    const ttlSeconds = Math.max(
      Math.floor((session.expiresAt - Date.now()) / 1000),
      30,
    );
    await this.redis.set(baseKey, JSON.stringify(session), 'EX', ttlSeconds);

    return {
      sessionId,
      state: session.state,
      offerDeviceId: session.offerDeviceId,
      offerPublicKey: session.offerPublicKey,
      expiresAt: session.expiresAt,
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/sync/session/:sessionId')
  /** Polls the current state of a sync session (offer/answer keys, manifest, etc.). */
  async getSyncSessionState(
    @Param('sessionId') sessionIdRaw: string,
    @Headers('x-user-id') userIdRaw: string,
  ) {
    const sessionId = sanitizeQueryValue(sessionIdRaw, 'sessionId');
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const raw = await this.redis.get(`sync:session:${sessionId}`);
    if (!raw)
      throw new BadRequestException('Sync session not found or expired');

    const session = JSON.parse(raw) as SyncSessionState;
    if (session.userId !== userId)
      throw new BadRequestException('Session user mismatch');

    return {
      sessionId: session.sessionId,
      state: session.state,
      offerDeviceId: session.offerDeviceId,
      answerDeviceId: session.answerDeviceId,
      offerPublicKey: session.offerPublicKey,
      answerPublicKey: session.answerPublicKey,
      expiresAt: session.expiresAt,
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/sync/session/manifest')
  /** Uploads the local message ID manifest for a sync round so the peer can compute the diff. */
  async uploadSyncManifest(
    @Body()
    body: {
      sessionId: string;
      userId: string;
      deviceId: string;
      manifest: SyncManifestPayload;
    },
    @Headers('x-user-id') headerUserId?: string,
  ) {
    const sessionId = sanitizeQueryValue(body.sessionId, 'sessionId');
    const userId = this.assertBodyUser(headerUserId, body.userId);
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const manifest = sanitizeSyncManifest(body.manifest);

    const baseKey = `sync:session:${sessionId}`;
    const raw = await this.redis.get(baseKey);
    if (!raw)
      throw new BadRequestException('Sync session not found or expired');
    const session = JSON.parse(raw) as SyncSessionState;

    if (session.userId !== userId)
      throw new BadRequestException('Session user mismatch');
    if (
      deviceId !== session.offerDeviceId &&
      deviceId !== session.answerDeviceId
    ) {
      throw new BadRequestException('Device is not part of this session');
    }

    const ttlSeconds = Math.max(
      Math.floor((session.expiresAt - Date.now()) / 1000),
      30,
    );
    const manifestKey = `sync:session:${sessionId}:manifest:${deviceId}`;
    await this.redis.set(
      manifestKey,
      JSON.stringify(manifest),
      'EX',
      ttlSeconds,
    );

    return {
      status: 'stored',
      conversations: manifest.conversations.length,
      generatedAt: manifest.generatedAt,
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/sync/session/diff')
  /** Computes and returns the set of message IDs the calling peer is missing compared to the stored manifest. */
  async computeSyncDiff(
    @Body()
    body: {
      sessionId: string;
      userId: string;
      deviceId: string;
    },
    @Headers('x-user-id') headerUserId?: string,
  ) {
    const sessionId = sanitizeQueryValue(body.sessionId, 'sessionId');
    const userId = this.assertBodyUser(headerUserId, body.userId);
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');

    const baseKey = `sync:session:${sessionId}`;
    const raw = await this.redis.get(baseKey);
    if (!raw)
      throw new BadRequestException('Sync session not found or expired');
    const session = JSON.parse(raw) as SyncSessionState;

    if (session.userId !== userId)
      throw new BadRequestException('Session user mismatch');
    if (
      deviceId !== session.offerDeviceId &&
      deviceId !== session.answerDeviceId
    ) {
      throw new BadRequestException('Device is not part of this session');
    }
    if (!session.answerDeviceId) {
      throw new BadRequestException('Second device has not joined yet');
    }

    const peerDeviceId =
      deviceId === session.offerDeviceId
        ? session.answerDeviceId
        : session.offerDeviceId;
    const requesterKey = `sync:session:${sessionId}:manifest:${deviceId}`;
    const peerKey = `sync:session:${sessionId}:manifest:${peerDeviceId}`;

    const requesterRaw = await this.redis.get(requesterKey);
    const peerRaw = await this.redis.get(peerKey);
    if (!requesterRaw || !peerRaw) {
      throw new BadRequestException(
        'Both manifests must be uploaded before diff computation',
      );
    }

    const requesterManifest = sanitizeSyncManifest(JSON.parse(requesterRaw));
    const peerManifest = sanitizeSyncManifest(JSON.parse(peerRaw));
    const { missingOnRequester, missingOnPeer } = computeManifestDiff(
      requesterManifest,
      peerManifest,
    );

    return {
      sessionId,
      requesterDeviceId: deviceId,
      peerDeviceId,
      generatedAt: Date.now(),
      missingOnRequester,
      missingOnPeer,
      stats: {
        requesterConversationCount: requesterManifest.conversations.length,
        peerConversationCount: peerManifest.conversations.length,
        requesterMissingMessageCount: missingOnRequester.reduce(
          (acc, conv) => acc + conv.messageIds.length,
          0,
        ),
        peerMissingMessageCount: missingOnPeer.reduce(
          (acc, conv) => acc + conv.messageIds.length,
          0,
        ),
      },
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/sync/session/chunks/upload')
  /** Uploads a batch of encrypted message chunks to the sync session for the peer to pull. */
  async uploadSyncChunks(
    @Body()
    body: {
      sessionId: string;
      userId: string;
      fromDeviceId: string;
      toDeviceId: string;
      chunks: SyncSerializedChunk[];
    },
    @Headers('x-user-id') headerUserId?: string,
  ) {
    const sessionId = sanitizeQueryValue(body.sessionId, 'sessionId');
    const userId = this.assertBodyUser(headerUserId, body.userId);
    const fromDeviceId = sanitizeQueryValue(body.fromDeviceId, 'fromDeviceId');
    const toDeviceId = sanitizeQueryValue(body.toDeviceId, 'toDeviceId');
    const chunks = sanitizeSerializedChunks(body.chunks);

    const raw = await this.redis.get(`sync:session:${sessionId}`);
    if (!raw)
      throw new BadRequestException('Sync session not found or expired');
    const session = JSON.parse(raw) as SyncSessionState;
    if (session.userId !== userId)
      throw new BadRequestException('Session user mismatch');

    const participants = new Set([
      session.offerDeviceId,
      session.answerDeviceId,
    ]);
    if (!participants.has(fromDeviceId) || !participants.has(toDeviceId)) {
      throw new BadRequestException('Devices are not part of this session');
    }

    const ttlSeconds = Math.max(
      Math.floor((session.expiresAt - Date.now()) / 1000),
      30,
    );
    const key = `sync:session:${sessionId}:chunks:${toDeviceId}:${fromDeviceId}`;

    // Append each chunk individually so multiple batched uploads accumulate in order.
    const pipeline = this.redis.pipeline();
    for (const chunk of chunks) {
      pipeline.rpush(key, JSON.stringify(chunk));
    }
    pipeline.expire(key, ttlSeconds);
    await pipeline.exec();

    return {
      status: 'stored',
      chunkCount: chunks.length,
      rowCount: chunks.reduce((acc, chunk) => acc + chunk.rows.length, 0),
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/sync/session/:sessionId/chunks/pull')
  /** Downloads encrypted message chunks the peer uploaded for this device during sync. */
  async pullSyncChunks(
    @Param('sessionId') sessionIdRaw: string,
    @Headers('x-user-id') userIdRaw: string,
    @Query('toDeviceId') toDeviceIdRaw: string,
    @Query('fromDeviceId') fromDeviceIdRaw: string,
  ) {
    const sessionId = sanitizeQueryValue(sessionIdRaw, 'sessionId');
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const toDeviceId = sanitizeQueryValue(toDeviceIdRaw, 'toDeviceId');
    const fromDeviceId = sanitizeQueryValue(fromDeviceIdRaw, 'fromDeviceId');

    const raw = await this.redis.get(`sync:session:${sessionId}`);
    if (!raw)
      throw new BadRequestException('Sync session not found or expired');
    const session = JSON.parse(raw) as SyncSessionState;
    if (session.userId !== userId)
      throw new BadRequestException('Session user mismatch');

    const participants = new Set([
      session.offerDeviceId,
      session.answerDeviceId,
    ]);
    if (!participants.has(fromDeviceId) || !participants.has(toDeviceId)) {
      throw new BadRequestException('Devices are not part of this session');
    }

    const key = `sync:session:${sessionId}:chunks:${toDeviceId}:${fromDeviceId}`;

    // Each item in the list is one serialized SyncSerializedChunk (batched uploads accumulate here).
    const rawItems = await this.redis.lrange(key, 0, -1);
    const chunks =
      rawItems.length > 0
        ? sanitizeSerializedChunks(
            rawItems.map((item) => JSON.parse(item) as unknown),
          )
        : [];

    return {
      sessionId,
      toDeviceId,
      fromDeviceId,
      chunks,
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/sync/session/:sessionId/chunks/ack')
  @HttpCode(200)
  /** Deletes pulled sync chunks after the client has persisted them locally. */
  async ackSyncChunks(
    @Param('sessionId') sessionIdRaw: string,
    @Headers('x-user-id') userIdRaw: string,
    @Body()
    body: {
      toDeviceId: string;
      fromDeviceId: string;
    },
  ) {
    const sessionId = sanitizeQueryValue(sessionIdRaw, 'sessionId');
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const toDeviceId = sanitizeQueryValue(body.toDeviceId, 'toDeviceId');
    const fromDeviceId = sanitizeQueryValue(body.fromDeviceId, 'fromDeviceId');

    const raw = await this.redis.get(`sync:session:${sessionId}`);
    if (!raw)
      throw new BadRequestException('Sync session not found or expired');
    const session = JSON.parse(raw) as SyncSessionState;
    if (session.userId !== userId)
      throw new BadRequestException('Session user mismatch');

    const key = `sync:session:${sessionId}:chunks:${toDeviceId}:${fromDeviceId}`;
    await this.redis.del(key);
    return { status: 'acknowledged' };
  }
}
