import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, AnyBulkWriteOperation, Types } from 'mongoose';
import { QueuedMessage } from './queued-message.schema';
import { KeyPackage } from './key-package.schema';
import { WelcomeMessage } from './welcome-message.schema';
import { GroupMember } from './group-member.schema';
import { Group } from './group.schema';
import { PinVerifier } from './pin-verifier.schema';
import Redis from 'ioredis';
import * as crypto from 'crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { encodeInboundMsgEnvelope } from '@mines-app/shared-ts';

const SAFE_QUERY_VALUE_REGEX = /^[a-zA-Z0-9_.:@-]{1,128}$/;

function sanitizeQueryValue(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestException(`${fieldName} is required`);
  }

  if (!SAFE_QUERY_VALUE_REGEX.test(trimmed)) {
    throw new BadRequestException(`${fieldName} contains invalid characters`);
  }

  return trimmed;
}

function sanitizeOptionalQueryValue(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return sanitizeQueryValue(value, fieldName);
}

function sanitizeObjectIdList(value: unknown): Types.ObjectId[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('messageIds must be an array');
  }

  const objectIds: Types.ObjectId[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !Types.ObjectId.isValid(id)) {
      throw new BadRequestException('messageIds contains invalid ObjectId');
    }
    objectIds.push(new Types.ObjectId(id));
  }

  return objectIds;
}

function isPrivateIpAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const normalized = ip.toLowerCase();
    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    );
  }

  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part)))
    return true;

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BadRequestException('Only http/https URLs are allowed');
  }

  if (parsed.username || parsed.password) {
    throw new BadRequestException('URL credentials are not allowed');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new BadRequestException('Localhost URLs are not allowed');
  }

  if (isIP(hostname) && isPrivateIpAddress(hostname)) {
    throw new BadRequestException('Private network URLs are not allowed');
  }

  const resolved = await lookup(hostname, { all: true });
  if (resolved.length === 0) {
    throw new BadRequestException('Host cannot be resolved');
  }

  for (const entry of resolved) {
    if (isPrivateIpAddress(entry.address)) {
      throw new BadRequestException('Private network URLs are not allowed');
    }
  }

  return parsed;
}

function decodeHtmlEntity(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMetaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    'i',
  );
  const match = html.match(regex);
  return match ? decodeHtmlEntity(match[1].trim()) : null;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? decodeHtmlEntity(match[1].trim()) : null;
}

function buildLinkPreviewPayload(html: string, targetUrl: URL) {
  const title =
    extractMetaContent(html, 'og:title') ||
    extractTitle(html) ||
    targetUrl.hostname;
  const description =
    extractMetaContent(html, 'og:description') ||
    extractMetaContent(html, 'description') ||
    '';
  const siteName =
    extractMetaContent(html, 'og:site_name') || targetUrl.hostname;

  const rawImage = extractMetaContent(html, 'og:image');
  let image = '';
  if (rawImage) {
    try {
      image = new URL(rawImage, targetUrl).toString();
    } catch {
      image = '';
    }
  }

  return {
    url: targetUrl.toString(),
    title: title.slice(0, 180),
    description: description.slice(0, 280),
    image,
    siteName: siteName.slice(0, 120),
  };
}

import { v4 as uuidv4 } from 'uuid';

interface SyncConversationManifest {
  conversationId: string;
  groupId?: string;
  updatedAt?: number;
  messageIds: string[];
}

interface SyncManifestPayload {
  generatedAt: number;
  conversations: SyncConversationManifest[];
}

interface SyncSessionState {
  sessionId: string;
  userId: string;
  offerDeviceId: string;
  offerPublicKey: string;
  answerDeviceId?: string;
  answerPublicKey?: string;
  joinTokenHash: string;
  state: 'waiting_join' | 'joined';
  createdAt: number;
  expiresAt: number;
}

interface SyncSerializedEncryptedRow {
  id: string;
  conversationId: string;
  timestamp: number;
  iv: number[];
  salt: number[];
  cipherText: number[];
}

interface SyncSerializedChunk {
  conversation: {
    id: string;
    groupId: string;
    name: string;
    isReady: boolean;
    updatedAt: number;
  };
  rows: SyncSerializedEncryptedRow[];
}

function hashJoinToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n <= 0) return fallback;
  return n;
}

function sanitizeMessageIdList(messageIds: unknown): string[] {
  if (!Array.isArray(messageIds)) {
    throw new BadRequestException('messageIds must be an array of strings');
  }

  const ids = messageIds.map((id) => sanitizeQueryValue(id, 'messageId'));
  return [...new Set(ids)];
}

function sanitizeSyncManifest(payload: unknown): SyncManifestPayload {
  if (!payload || typeof payload !== 'object') {
    throw new BadRequestException('manifest is required');
  }

  const record = payload as Record<string, unknown>;
  const generatedAt =
    typeof record.generatedAt === 'number' &&
    Number.isFinite(record.generatedAt)
      ? Math.floor(record.generatedAt)
      : Date.now();

  if (!Array.isArray(record.conversations)) {
    throw new BadRequestException('manifest.conversations must be an array');
  }

  const conversations: SyncConversationManifest[] = record.conversations.map(
    (raw) => {
      if (!raw || typeof raw !== 'object') {
        throw new BadRequestException('manifest conversation entry is invalid');
      }

      const entry = raw as Record<string, unknown>;
      const conversationId = sanitizeQueryValue(
        entry.conversationId,
        'conversationId',
      );
      const groupId = sanitizeOptionalQueryValue(entry.groupId, 'groupId');
      const updatedAt =
        typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
          ? Math.floor(entry.updatedAt)
          : undefined;
      const messageIds = sanitizeMessageIdList(entry.messageIds);

      return {
        conversationId,
        groupId,
        updatedAt,
        messageIds,
      };
    },
  );

  return { generatedAt, conversations };
}

function sanitizeByteArray(value: unknown, fieldName: string): number[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${fieldName} must be an array`);
  }
  const bytes = value.map((v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
      throw new BadRequestException(
        `${fieldName} contains invalid byte values`,
      );
    }
    return v;
  });
  return bytes;
}

function sanitizeDisplayText(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} must be a string`);
  }
  const text = value.trim();
  if (!text) {
    throw new BadRequestException(`${fieldName} is required`);
  }
  if (text.length > 256) {
    throw new BadRequestException(`${fieldName} is too long`);
  }
  return text;
}

function sanitizeSerializedChunks(value: unknown): SyncSerializedChunk[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('chunks must be an array');
  }

  if (value.length > 2000) {
    throw new BadRequestException('chunks payload too large');
  }

  return value.map((rawChunk) => {
    if (!rawChunk || typeof rawChunk !== 'object') {
      throw new BadRequestException('chunk entry is invalid');
    }

    const chunk = rawChunk as Record<string, unknown>;
    const rawConversation = chunk.conversation as Record<string, unknown>;
    if (!rawConversation || typeof rawConversation !== 'object') {
      throw new BadRequestException('chunk.conversation is required');
    }

    const conversation = {
      id: sanitizeQueryValue(rawConversation.id, 'conversation.id'),
      groupId: sanitizeQueryValue(
        rawConversation.groupId,
        'conversation.groupId',
      ),
      name: sanitizeDisplayText(rawConversation.name, 'conversation.name'),
      isReady: Boolean(rawConversation.isReady),
      updatedAt:
        typeof rawConversation.updatedAt === 'number' &&
        Number.isFinite(rawConversation.updatedAt)
          ? Math.floor(rawConversation.updatedAt)
          : Date.now(),
    };

    if (!Array.isArray(chunk.rows)) {
      throw new BadRequestException('chunk.rows must be an array');
    }

    const rows: SyncSerializedEncryptedRow[] = chunk.rows.map((rawRow) => {
      if (!rawRow || typeof rawRow !== 'object') {
        throw new BadRequestException('chunk row is invalid');
      }

      const row = rawRow as Record<string, unknown>;
      return {
        id: sanitizeQueryValue(row.id, 'row.id'),
        conversationId: sanitizeQueryValue(
          row.conversationId,
          'row.conversationId',
        ),
        timestamp:
          typeof row.timestamp === 'number' && Number.isFinite(row.timestamp)
            ? Math.floor(row.timestamp)
            : Date.now(),
        iv: sanitizeByteArray(row.iv, 'row.iv'),
        salt: sanitizeByteArray(row.salt, 'row.salt'),
        cipherText: sanitizeByteArray(row.cipherText, 'row.cipherText'),
      };
    });

    return { conversation, rows };
  });
}

function computeManifestDiff(
  requester: SyncManifestPayload,
  peer: SyncManifestPayload,
) {
  const requesterByConversation = new Map(
    requester.conversations.map((c) => [c.conversationId, c]),
  );
  const peerByConversation = new Map(
    peer.conversations.map((c) => [c.conversationId, c]),
  );

  const allConversationIds = new Set<string>([
    ...requesterByConversation.keys(),
    ...peerByConversation.keys(),
  ]);

  const missingOnRequester: SyncConversationManifest[] = [];
  const missingOnPeer: SyncConversationManifest[] = [];

  for (const conversationId of allConversationIds) {
    const requesterConv = requesterByConversation.get(conversationId);
    const peerConv = peerByConversation.get(conversationId);

    const requesterIds = new Set(requesterConv?.messageIds ?? []);
    const peerIds = new Set(peerConv?.messageIds ?? []);

    const requesterMissing = [...peerIds].filter((id) => !requesterIds.has(id));
    if (requesterMissing.length > 0) {
      missingOnRequester.push({
        conversationId,
        groupId: requesterConv?.groupId ?? peerConv?.groupId,
        updatedAt: requesterConv?.updatedAt ?? peerConv?.updatedAt,
        messageIds: requesterMissing,
      });
    }

    const peerMissing = [...requesterIds].filter((id) => !peerIds.has(id));
    if (peerMissing.length > 0) {
      missingOnPeer.push({
        conversationId,
        groupId: requesterConv?.groupId ?? peerConv?.groupId,
        updatedAt: requesterConv?.updatedAt ?? peerConv?.updatedAt,
        messageIds: peerMissing,
      });
    }
  }

  return { missingOnRequester, missingOnPeer };
}

@Controller()
export class AppController {
  constructor(
    @InjectModel(QueuedMessage.name)
    private queuedMessageModel: Model<QueuedMessage>,
    @InjectModel(KeyPackage.name) private keyPackageModel: Model<KeyPackage>,
    @InjectModel(WelcomeMessage.name)
    private welcomeMessageModel: Model<WelcomeMessage>,
    @InjectModel(GroupMember.name) private groupMemberModel: Model<GroupMember>,
    @InjectModel(Group.name) private groupModel: Model<Group>,
    @InjectModel(PinVerifier.name) private pinVerifierModel: Model<PinVerifier>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  @Post('mls-api/sync/session/start')
  async startSyncSession(
    @Body()
    body: {
      userId: string;
      deviceId: string;
      offerPublicKey: string;
      ttlSeconds?: number;
    },
  ) {
    const userId = sanitizeQueryValue(body.userId, 'userId');
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

  @Post('mls-api/sync/session/join')
  async joinSyncSession(
    @Body()
    body: {
      sessionId: string;
      joinToken: string;
      userId: string;
      deviceId: string;
      answerPublicKey: string;
    },
  ) {
    const sessionId = sanitizeQueryValue(body.sessionId, 'sessionId');
    const joinToken = sanitizeQueryValue(body.joinToken, 'joinToken');
    const userId = sanitizeQueryValue(body.userId, 'userId');
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

  @Get('mls-api/sync/session/:sessionId')
  async getSyncSessionState(
    @Param('sessionId') sessionIdRaw: string,
    @Query('userId') userIdRaw: string,
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

  @Post('mls-api/sync/session/manifest')
  async uploadSyncManifest(
    @Body()
    body: {
      sessionId: string;
      userId: string;
      deviceId: string;
      manifest: SyncManifestPayload;
    },
  ) {
    const sessionId = sanitizeQueryValue(body.sessionId, 'sessionId');
    const userId = sanitizeQueryValue(body.userId, 'userId');
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

  @Post('mls-api/sync/session/diff')
  async computeSyncDiff(
    @Body()
    body: {
      sessionId: string;
      userId: string;
      deviceId: string;
    },
  ) {
    const sessionId = sanitizeQueryValue(body.sessionId, 'sessionId');
    const userId = sanitizeQueryValue(body.userId, 'userId');
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

  @Post('mls-api/sync/session/chunks/upload')
  async uploadSyncChunks(
    @Body()
    body: {
      sessionId: string;
      userId: string;
      fromDeviceId: string;
      toDeviceId: string;
      chunks: SyncSerializedChunk[];
    },
  ) {
    const sessionId = sanitizeQueryValue(body.sessionId, 'sessionId');
    const userId = sanitizeQueryValue(body.userId, 'userId');
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
    await this.redis.set(key, JSON.stringify(chunks), 'EX', ttlSeconds);

    return {
      status: 'stored',
      chunkCount: chunks.length,
      rowCount: chunks.reduce((acc, chunk) => acc + chunk.rows.length, 0),
    };
  }

  @Get('mls-api/sync/session/:sessionId/chunks/pull')
  async pullSyncChunks(
    @Param('sessionId') sessionIdRaw: string,
    @Query('userId') userIdRaw: string,
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
    const chunkRaw = await this.redis.get(key);
    const chunks = chunkRaw
      ? sanitizeSerializedChunks(JSON.parse(chunkRaw))
      : [];

    // One-shot pull acts as ACK.
    if (chunkRaw) {
      await this.redis.del(key);
    }

    return {
      sessionId,
      toDeviceId,
      fromDeviceId,
      chunks,
    };
  }

  /**
   * Check (and register on first use) the PIN verifier for a user.
   *
   * The client sends a PBKDF2-SHA-256 verifier derived from the PIN and
   * userId.  We never see the raw PIN.
   *
   * Responses:
   *   { status: 'registered' }  – first device; verifier stored server-side.
   *   { status: 'ok' }          – verifier matches; PIN is consistent.
   *   { status: 'mismatch' }    – verifier differs; wrong PIN for this user.
   */
  @Post('mls-api/pin-verifier/check')
  async checkPinVerifier(@Body() body: { userId: string; verifier: string }) {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeVerifier = sanitizeQueryValue(body.verifier, 'verifier');

    // Verifier must be a 64-char lowercase hex string (32 bytes PBKDF2 output).
    if (!/^[0-9a-f]{64}$/.test(safeVerifier)) {
      throw new BadRequestException('verifier format invalid');
    }

    const doc = await this.pinVerifierModel
      .findOne({ userId: safeUserId })
      .exec();

    if (!doc) {
      await this.pinVerifierModel.create({
        userId: safeUserId,
        verifier: safeVerifier,
      });
      return { status: 'registered' };
    }

    // Constant-time comparison to prevent timing-based inference.
    const stored = Buffer.from(doc.verifier, 'hex');
    const incoming = Buffer.from(safeVerifier, 'hex');
    const match =
      stored.length === incoming.length &&
      crypto.timingSafeEqual(stored, incoming);

    return { status: match ? 'ok' : 'mismatch' };
  }

  @Get('mls-api/link-preview')
  async getLinkPreview(@Query('url') url: string) {
    if (!url || typeof url !== 'string') {
      throw new BadRequestException('url is required');
    }

    const targetUrl = await assertSafeExternalUrl(url);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 4000);

    try {
      const response = await fetch(targetUrl.toString(), {
        method: 'GET',
        redirect: 'follow',
        signal: abortController.signal,
        headers: {
          'user-agent': 'CanariLinkPreview/1.0',
          accept: 'text/html,application/xhtml+xml',
        },
      });

      if (!response.ok) {
        throw new BadRequestException('Unable to fetch URL');
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('text/html')) {
        throw new BadRequestException('URL is not an HTML page');
      }

      const contentLength = Number.parseInt(
        response.headers.get('content-length') || '0',
        10,
      );
      if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
        throw new BadRequestException('Page is too large to preview');
      }

      const html = (await response.text()).slice(0, 220_000);
      return buildLinkPreviewPayload(html, targetUrl);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Link preview failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  @Post('mls-api/groups')
  async createGroup(@Body() body: { name: string; createdBy: string }) {
    const groupId = uuidv4();
    await this.groupModel.create({
      groupId,
      name: body.name,
      createdBy: body.createdBy,
      createdAt: new Date(),
    });
    return { groupId, name: body.name };
  }

  @Get('mls-api/groups/:groupId')
  async getGroup(@Param('groupId') groupId: string) {
    return this.groupModel.findOne({ groupId }).exec();
  }

  @Post('mls-api/groups/:groupId/members')
  async addGroupMember(
    @Param('groupId') groupId: string,
    @Body() body: { userId: string; deviceId: string },
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(body.deviceId, 'deviceId');

    await this.groupMemberModel.updateOne(
      { groupId: safeGroupId, userId: safeUserId, deviceId: safeDeviceId },
      { $set: { joinedAt: new Date() } },
      { upsert: true },
    );
    // Sync to Redis for Gateway access
    await this.redis.sadd(
      `group:members:${safeGroupId}`,
      `${safeUserId}:${safeDeviceId}`,
    );
    return { status: 'added' };
  }

  @Get('mls-api/groups/:groupId/members')
  async getGroupMembers(@Param('groupId') groupId: string) {
    return this.groupMemberModel.find({ groupId }).exec();
  }

  @Patch('mls-api/groups/:groupId')
  async renameGroup(
    @Param('groupId') groupId: string,
    @Body() body: { name: string },
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new BadRequestException('name is required');
    }
    await this.groupModel.updateOne(
      { groupId: safeGroupId },
      { $set: { name: body.name.trim() } },
    );
    return { status: 'renamed' };
  }

  @Delete('mls-api/groups/:groupId/members/:userId')
  async removeGroupMember(
    @Param('groupId') groupId: string,
    @Param('userId') userId: string,
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    await this.groupMemberModel.deleteMany({
      groupId: safeGroupId,
      userId: safeUserId,
    });
    // Remove all devices of this user from the Redis set
    const members = await this.redis.smembers(`group:members:${safeGroupId}`);
    const toRemove = members.filter((m) => m.startsWith(`${safeUserId}:`));
    if (toRemove.length > 0) {
      await this.redis.srem(`group:members:${safeGroupId}`, ...toRemove);
    }
    return { status: 'removed' };
  }

  @Delete('mls-api/groups/:groupId')
  async deleteGroup(@Param('groupId') groupId: string) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    await this.groupModel.deleteOne({ groupId: safeGroupId });
    await this.groupMemberModel.deleteMany({ groupId: safeGroupId });
    await this.redis.del(`group:members:${safeGroupId}`);
    return { status: 'deleted' };
  }

  @Post('mls-api/register-device')
  async registerDevice(
    @Body() body: { userId: string; deviceId: string; keyPackage: string },
  ) {
    await this.keyPackageModel.updateOne(
      { userId: body.userId, deviceId: body.deviceId },
      {
        $set: {
          keyPackage: body.keyPackage,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    return { status: 'registered' };
  }

  @Get('mls-api/devices/:userId')
  async getUserDevices(@Param('userId') userId: string) {
    // Only return devices active in the last 30 days (avoids stale key packages)
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return this.keyPackageModel
      .find({ userId, createdAt: { $gte: cutoff } })
      .sort({ createdAt: -1 })
      .exec();
  }

  @Post('mls-api/welcome')
  async sendWelcome(
    @Body()
    body: {
      targetDeviceId: string;
      targetUserId?: string; // used to disambiguate when multiple users share a device ID
      senderUserId?: string; // the user who is inviting (their identity shown to the recipient)
      welcomePayload: string;
      ratchetTreePayload?: string;
      groupId: string;
    },
  ) {
    const targetDeviceId = sanitizeQueryValue(
      body.targetDeviceId,
      'targetDeviceId',
    );
    const targetUserId = sanitizeOptionalQueryValue(
      body.targetUserId,
      'targetUserId',
    );
    const senderUserId =
      sanitizeOptionalQueryValue(body.senderUserId, 'senderUserId') || 'system';
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');

    // Look up recipient device — include userId in the query when provided so the lookup
    // is unambiguous even if two users happen to share the same raw device ID string
    // (common in same-browser multi-tab testing).
    const query: Record<string, string> = { deviceId: targetDeviceId };
    if (targetUserId) {
      query.userId = targetUserId;
    }
    const deviceInfo = await this.keyPackageModel.findOne(query).exec();

    if (!deviceInfo) {
      throw new Error(
        `Device ${targetDeviceId} (user: ${targetUserId ?? 'unknown'}) not found. Cannot deliver Welcome message.`,
      );
    }

    await this.welcomeMessageModel.create({
      deviceId: targetDeviceId,
      userId: deviceInfo.userId,
      senderUserId,
      groupId: safeGroupId,
      message: body.welcomePayload,
      ratchetTree: body.ratchetTreePayload,
      createdAt: new Date(),
    });

    // Real-time push via Gateway when the target device is currently online.
    const redisKey = `user:online:${deviceInfo.userId}:${targetDeviceId}`;
    const isOnline = await this.redis.exists(redisKey);
    console.log(`[DELIVERY] Checking presence for ${redisKey} -> ${isOnline}`);
    if (isOnline) {
      const ciphertext = Buffer.from(body.welcomePayload, 'base64');
      const envelope = JSON.stringify({
        recipientId: deviceInfo.userId,
        deviceId: targetDeviceId,
        senderId: senderUserId,
        senderDeviceId: '',
        groupId: safeGroupId,
        isWelcome: true,
        ratchetTree: body.ratchetTreePayload,
        proto: ciphertext.toString('base64'),
      });
      console.log(
        `[DELIVERY] Publishing Welcome message to ${redisKey}, envelope length: ${envelope.length}`,
      );
      await this.redis.publish('chat:messages', envelope);
    } else {
      console.log(`[DELIVERY] Target ${redisKey} is OFFLINE, message queued.`);
    }

    return { status: 'queued' };
  }

  @Get('mls-api/welcome/:deviceId')
  async getWelcomeMessages(@Param('deviceId') deviceId: string) {
    const messages = await this.welcomeMessageModel.find({ deviceId }).exec();
    // Delete immediately after reading: MLS init keys are ephemeral and can only be
    // consumed once. Re-processing the same welcome on reconnect would always fail.
    if (messages.length > 0) {
      await this.welcomeMessageModel.deleteMany({ deviceId });
    }
    return messages;
  }

  @Post('mls-api/send')
  async sendMessage(
    @Body()
    body: {
      proto?: string; // base64(raw MLS ciphertext) — sent by gateway
      recipients?: { userId: string; deviceId?: string }[];
      senderId?: string;
      senderDeviceId?: string;
      groupId?: string;
      isWelcome?: boolean;
      // legacy fields (frontend fallback / group fan-out)
      content?: string;
      type?: string;
    },
  ) {
    const ops: AnyBulkWriteOperation<QueuedMessage>[] = [];
    let sentCount = 0;

    if (body.proto) {
      // ── Proto path (gateway): proto = base64(raw MLS ciphertext) ─────────
      const { proto } = body;
      for (const r of body.recipients ?? []) {
        if (!r.userId || !r.deviceId) continue;
        const recipientUserId = sanitizeQueryValue(
          r.userId,
          'recipients.userId',
        );
        const recipientDeviceId = sanitizeQueryValue(
          r.deviceId,
          'recipients.deviceId',
        );
        const redisKey = `user:online:${recipientUserId}:${recipientDeviceId}`;
        const isOnline = await this.redis.exists(redisKey);
        console.log(
          `[DELIVERY] Checking presence for ${redisKey} -> ${isOnline}`,
        );
        if (isOnline) {
          const envelope = JSON.stringify({
            recipientId: recipientUserId,
            deviceId: recipientDeviceId,
            senderId: body.senderId ?? '',
            senderDeviceId: body.senderDeviceId ?? '',
            groupId: body.groupId ?? '',
            isWelcome: body.isWelcome ?? false,
            proto,
          });
          console.log(
            `[DELIVERY] Publishing proto message to ${redisKey}, envelope length: ${envelope.length}`,
          );
          await this.redis.publish('chat:messages', envelope);
          sentCount++;
        } else {
          ops.push({
            insertOne: {
              document: {
                recipientId: recipientUserId,
                deviceId: recipientDeviceId,
                senderId: body.senderId,
                senderDeviceId: body.senderDeviceId,
                groupId: body.groupId,
                isWelcome: body.isWelcome,
                proto,
                createdAt: new Date(),
              },
            },
          });
        }
      }
    } else {
      // ── Legacy path (frontend fallback / group fan-out) ───────────────────
      const senderId = sanitizeQueryValue(body.senderId, 'senderId');
      const senderDeviceId = sanitizeOptionalQueryValue(
        body.senderDeviceId,
        'senderDeviceId',
      );
      const groupId = sanitizeQueryValue(body.groupId, 'groupId');
      const { content, type } = body;

      let targetList: { userId: string; deviceId: string }[] = [];

      if (!body.recipients || body.recipients.length === 0) {
        const members = await this.groupMemberModel
          .find({ groupId })
          .lean()
          .exec();
        targetList = members
          .filter((m) => {
            if (senderDeviceId)
              return !(m.userId === senderId && m.deviceId === senderDeviceId);
            return m.userId !== senderId;
          })
          .map((m) => ({ userId: m.userId, deviceId: m.deviceId }));
      } else {
        for (const r of body.recipients) {
          const recipientUserId = sanitizeQueryValue(
            r.userId,
            'recipients.userId',
          );
          if (r.deviceId) {
            const recipientDeviceId = sanitizeQueryValue(
              r.deviceId,
              'recipients.deviceId',
            );
            targetList.push({
              userId: recipientUserId,
              deviceId: recipientDeviceId,
            });
          } else {
            console.warn(
              'Skipping recipient without deviceId. Fan-out is disabled for MLS security.',
            );
          }
        }
      }

      for (const r of targetList) {
        const redisKey = `user:online:${r.userId}:${r.deviceId}`;
        const isOnline = await this.redis.exists(redisKey);
        console.log(
          `[DELIVERY] Checking presence for ${redisKey} -> ${isOnline}`,
        );
        if (isOnline) {
          const ciphertext = Buffer.from(content, 'base64');
          const isWelcome = type === 'mlsWelcome';
          console.log(
            `[DELIVERY] Encoding message for ${redisKey}, isWelcome: ${isWelcome}`,
          );
          const envelope = await Promise.resolve(
            encodeInboundMsgEnvelope(r.userId, r.deviceId, {
              ciphertext,
              senderId,
              senderDeviceId: senderDeviceId ?? '',
              groupId,
              isWelcome,
            }),
          );
          console.log(
            `[DELIVERY] Publishing Message to ${redisKey}, envelope length: ${envelope.length}`,
          );
          await this.redis.publish('chat:messages', envelope);
          sentCount++;
        } else {
          ops.push({
            insertOne: {
              document: {
                recipientId: r.userId,
                deviceId: r.deviceId,
                senderId,
                senderDeviceId,
                groupId,
                content: content,
                type,
                createdAt: new Date(),
              },
            },
          });
        }
      }
    }

    if (ops.length > 0) {
      await this.queuedMessageModel.bulkWrite(ops);
    }

    return { status: 'processed', queued: ops.length, sent: sentCount };
  }

  @Get('history/:groupId')
  async getHistory(
    @Param('groupId') groupId: string,
  ): Promise<Record<string, unknown>[]> {
    const streamKey = `history:${groupId}`;
    try {
      // ioredis xrange returns [id, [key, value, key, value...]]
      const entries = await this.redis.xrange(streamKey, '-', '+');
      return entries.map(([id, fields]) => {
        const msg: Record<string, unknown> = { id };
        for (let i = 0; i < fields.length; i += 2) {
          msg[fields[i]] = fields[i + 1];
        }
        return msg;
      });
    } catch (e) {
      console.error('History fetch error:', e);
      return [];
    }
  }

  @Get('mls-api/messages/:userId/:deviceId')
  async fetchMessages(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');

    // On renvoie juste la liste
    return this.queuedMessageModel
      .find({
        recipientId: safeUserId,
        deviceId: safeDeviceId,
      })
      .sort({ createdAt: 1 })
      .lean()
      .exec();
  }

  // 2. Nouvelle route d'Acquittement (ACK)
  @Post('mls-api/messages/ack')
  async acknowledgeMessages(
    @Body() body: { userId: string; deviceId: string; messageIds: string[] },
  ) {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const safeMessageIds = sanitizeObjectIdList(body.messageIds);

    if (safeMessageIds.length === 0) {
      return { status: 'ignored' };
    }

    // On supprime uniquement les messages que le client a confirmés
    const result = (await this.queuedMessageModel.deleteMany({
      _id: { $in: safeMessageIds },
      recipientId: safeUserId,
      deviceId: safeDeviceId, // Sécurité pour éviter qu'un device supprime les messages d'un autre
    })) as unknown as { deletedCount: number };

    return { status: 'deleted', count: result.deletedCount };
  }
}
