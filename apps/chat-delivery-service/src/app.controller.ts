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
  UseGuards,
  Headers,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, MoreThanOrEqual, LessThan } from 'typeorm';
import { QueuedMessage } from './entities/queued-message.entity';
import { KeyPackage } from './entities/key-package.entity';
import { OneTimeKeyPackage } from './entities/one-time-key-package.entity';
import { GroupMember } from './entities/group-member.entity';
import { Group } from './entities/group.entity';
import { PinVerifier } from './entities/pin-verifier.entity';
import { DeviceGroupMembership } from './entities/device-group-membership.entity';
import { PushToken } from './entities/push-token.entity';
import Redis from 'ioredis';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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

function sanitizeStringIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('messageIds must be an array');
  }

  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new BadRequestException('messageIds contains invalid ID');
    }
    ids.push(id.trim());
  }

  return ids;
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

function decodeHtmlEntity(value: unknown): string {
  const normalized = typeof value === 'string' ? value : '';
  return normalized
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMetaTags(html: string): Array<Record<string, string>> {
  const tags: string[] = html.match(/<meta\b[^>]*>/gi) ?? [];
  return tags.map((tag) => {
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z:-]+)\s*=\s*(["'])(.*?)\2/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(tag)) !== null) {
      const rawKey = String(match[1] ?? '').toLowerCase();
      const rawValue = String(match[3] ?? '').trim();
      if (!rawKey) continue;
      attrs[rawKey] = decodeHtmlEntity(rawValue);
    }
    return attrs;
  });
}

function extractMetaContent(html: string, key: string): string | null {
  const normalizedKey = key.toLowerCase();
  for (const attrs of extractMetaTags(html)) {
    const attrKey = attrs.property || attrs.name;
    if (attrKey?.toLowerCase() === normalizedKey && attrs.content) {
      return attrs.content;
    }
  }
  return null;
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

function isYouTubeHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'youtube.com' ||
    h === 'www.youtube.com' ||
    h === 'm.youtube.com' ||
    h === 'youtu.be'
  );
}

async function fetchYouTubeOEmbed(targetUrl: URL): Promise<{
  url: string;
  title: string;
  description: string;
  image: string;
  siteName: string;
} | null> {
  if (!isYouTubeHost(targetUrl.hostname)) return null;

  const oembed = new URL('https://www.youtube.com/oembed');
  oembed.searchParams.set('url', targetUrl.toString());
  oembed.searchParams.set('format', 'json');

  const response = await fetch(oembed.toString(), {
    method: 'GET',
    headers: {
      'user-agent': 'CanariLinkPreview/1.0',
      accept: 'application/json',
    },
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    title?: string;
    author_name?: string;
    thumbnail_url?: string;
  };

  if (!data.title) return null;

  return {
    url: targetUrl.toString(),
    title: data.title.slice(0, 180),
    description: data.author_name ? `YouTube • ${data.author_name}` : 'YouTube',
    image: data.thumbnail_url ?? '',
    siteName: 'YouTube',
  };
}

import { v4 as uuidv4 } from 'uuid';
import { HeaderAuthGuard } from './guards/header-auth.guard';

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
export class AppController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppController.name);
  private staleDeviceInterval: ReturnType<typeof setInterval>;
  private cleanupMessagesInterval: ReturnType<typeof setInterval>;
  private cleanupKeyPackagesInterval: ReturnType<typeof setInterval>;
  private cleanupOrphanedRedisGroupsInterval: ReturnType<typeof setInterval>;

  /**
   * Single source of truth for message retention / stale device TTL.
   * A device is "stale" when its queued messages have expired (7 days),
   * meaning it can no longer catch up by processing missed commits.
   */
  private static readonly MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  private makeTraceId(scope: string): string {
    return `${scope}-${crypto.randomUUID().slice(0, 8)}`;
  }

  constructor(
    @InjectRepository(QueuedMessage)
    private queuedMessageRepo: Repository<QueuedMessage>,
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    @InjectRepository(OneTimeKeyPackage)
    private oneTimeKeyPackageRepo: Repository<OneTimeKeyPackage>,
    @InjectRepository(GroupMember)
    private groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(Group) private groupRepo: Repository<Group>,
    @InjectRepository(PinVerifier)
    private pinVerifierRepo: Repository<PinVerifier>,
    @InjectRepository(DeviceGroupMembership)
    private deviceGroupRepo: Repository<DeviceGroupMembership>,
    @InjectRepository(PushToken)
    private pushTokenRepo: Repository<PushToken>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  onModuleInit() {
    // Initialize Firebase Admin SDK once if a service account is provided
    if (!admin.apps.length) {
      const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (sa) {
        try {
          const serviceAccount = JSON.parse(sa) as admin.ServiceAccount;
          admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
          });
          this.logger.log('[FIREBASE] Admin SDK initialized');
        } catch (e) {
          this.logger.error(
            '[FIREBASE] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON',
            e,
          );
        }
      } else {
        this.logger.warn(
          '[FIREBASE] FIREBASE_SERVICE_ACCOUNT_JSON not set — push disabled',
        );
      }
    }

    // Both crons run hourly — there's no point detecting staleness more
    // frequently than the message cleanup that defines it.
    const ONE_HOUR = 60 * 60 * 1000;

    // Detect stale devices: devices whose membership hasn't been updated
    // within MESSAGE_RETENTION_MS are reset to pending for re-invite.
    this.staleDeviceInterval = setInterval(() => {
      void this.detectStaleDevices().catch((e) =>
        this.logger.error('[CRON] detectStaleDevices failed', e),
      );
    }, ONE_HOUR);

    // Cleanup expired queued messages older than MESSAGE_RETENTION_MS
    this.cleanupMessagesInterval = setInterval(() => {
      void this.cleanupExpiredQueuedMessages().catch((e) =>
        this.logger.error('[CRON] cleanupExpiredQueuedMessages failed', e),
      );
    }, ONE_HOUR);

    // Cleanup KeyPackages older than 30 days whose device has no active membership
    this.cleanupKeyPackagesInterval = setInterval(() => {
      void this.cleanupExpiredKeyPackages().catch((e) =>
        this.logger.error('[CRON] cleanupExpiredKeyPackages failed', e),
      );
    }, ONE_HOUR);

    // Cleanup orphaned Redis group:members:* keys with no matching DB group
    this.cleanupOrphanedRedisGroupsInterval = setInterval(() => {
      void this.cleanupOrphanedRedisGroups().catch((e) =>
        this.logger.error('[CRON] cleanupOrphanedRedisGroups failed', e),
      );
    }, 6 * ONE_HOUR);

    this.logger.log(
      '[CRON] Stale device detection (1h), message cleanup (1h), ' +
        'key-package cleanup (1h), orphaned Redis groups cleanup (6h) scheduled',
    );
  }

  onModuleDestroy() {
    clearInterval(this.staleDeviceInterval);
    clearInterval(this.cleanupMessagesInterval);
    clearInterval(this.cleanupKeyPackagesInterval);
    clearInterval(this.cleanupOrphanedRedisGroupsInterval);
  }

  /**
   * Detect devices whose membership hasn't been touched within the message
   * retention window.  Once their queued messages have been garbage-collected,
   * they can no longer catch up by processing missed commits — the only
   * recovery path is a full re-invite (reset to "pending").
   *
   * Only devices in "welcome_received" state are candidates: they were once
   * active but have gone silent for longer than the retention TTL.
   */
  private async detectStaleDevices() {
    const staleDate = new Date(Date.now() - AppController.MESSAGE_RETENTION_MS);

    const staleMembers = await this.deviceGroupRepo
      .createQueryBuilder('dgm')
      .where('dgm.status = :status', { status: 'welcome_received' })
      .andWhere('dgm.updatedAt < :staleDate', { staleDate })
      .getMany();

    for (const member of staleMembers) {
      member.status = 'stale';
      member.lastEpochSeen = 0;
      await this.deviceGroupRepo.save(member);
      await this.redis.srem(
        `group:members:${member.groupId}`,
        `${member.userId}:${member.deviceId}`,
      );
      this.logger.log(
        `[CRON] Stale device reset: device=${member.deviceId} group=${member.groupId} ` +
          `(lastUpdate=${member.updatedAt.toISOString()})`,
      );
    }

    if (staleMembers.length > 0) {
      this.logger.log(
        `[CRON] detectStaleDevices: ${staleMembers.length} device(s) reset to pending`,
      );
    }
  }

  /**
   * Delete queued messages older than MESSAGE_RETENTION_MS.
   */
  private async cleanupExpiredQueuedMessages() {
    const expiry = new Date(Date.now() - AppController.MESSAGE_RETENTION_MS);
    const result = await this.queuedMessageRepo.delete({
      createdAt: LessThan(expiry),
    });
    if (result.affected && result.affected > 0) {
      this.logger.log(
        `[CRON] cleanupExpiredQueuedMessages: deleted ${result.affected} message(s)`,
      );
    }
  }

  /**
   * Delete KeyPackages older than 30 days whose device has no active
   * group membership (status = welcome_received). These are leftover
   * packages published by devices that went offline permanently.
   */
  private async cleanupExpiredKeyPackages() {
    const KEY_PACKAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const expiry = new Date(Date.now() - KEY_PACKAGE_MAX_AGE_MS);

    const expiredPackages = await this.keyPackageRepo.find({
      where: { createdAt: LessThan(expiry) },
    });

    if (expiredPackages.length === 0) return;

    // Keep packages for devices that still have active group memberships
    const deviceIds = [...new Set(expiredPackages.map((kp) => kp.deviceId))];
    const activeDevices = await this.deviceGroupRepo
      .createQueryBuilder('dgm')
      .select('DISTINCT dgm.deviceId', 'deviceId')
      .where('dgm.deviceId IN (:...deviceIds)', { deviceIds })
      .andWhere('dgm.status = :status', { status: 'welcome_received' })
      .getRawMany<{ deviceId: string }>();

    const activeDeviceIds = new Set(activeDevices.map((d) => d.deviceId));
    const toDelete = expiredPackages.filter(
      (kp) => !activeDeviceIds.has(kp.deviceId),
    );

    if (toDelete.length > 0) {
      await this.keyPackageRepo.delete(toDelete.map((kp) => kp.id));
      this.logger.log(
        `[CRON] cleanupExpiredKeyPackages: deleted ${toDelete.length} package(s)`,
      );
    }
  }

  /**
   * Cleanup orphaned Redis `group:members:*` keys that reference groups
   * no longer present in the database. Uses SCAN to avoid blocking Redis.
   */
  private async cleanupOrphanedRedisGroups() {
    const orphanedKeys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        'group:members:*',
        'COUNT',
        100,
      );
      cursor = nextCursor;

      if (keys.length === 0) continue;

      const groupIds = keys.map((k) => k.replace('group:members:', ''));
      const existingGroups = await this.groupRepo.find({
        where: { id: In(groupIds) },
        select: ['id'],
      });
      const existingIds = new Set(existingGroups.map((g) => g.id));

      for (let i = 0; i < keys.length; i++) {
        if (!existingIds.has(groupIds[i])) {
          orphanedKeys.push(keys[i]);
        }
      }
    } while (cursor !== '0');

    if (orphanedKeys.length > 0) {
      await this.redis.del(...orphanedKeys);
      this.logger.log(
        `[CRON] cleanupOrphanedRedisGroups: deleted ${orphanedKeys.length} key(s)`,
      );
    }
  }

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

  @UseGuards(HeaderAuthGuard)
  @Get('mls-api/sync/session/:sessionId')
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

  @UseGuards(HeaderAuthGuard)
  @Get('mls-api/sync/session/:sessionId/chunks/pull')
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

    const doc = await this.pinVerifierRepo.findOne({
      where: { userId: safeUserId },
    });

    if (!doc) {
      const newDoc = this.pinVerifierRepo.create({
        userId: safeUserId,
        verifier: safeVerifier,
      });
      await this.pinVerifierRepo.save(newDoc);
      return { status: 'registered' };
    }

    if (typeof doc.verifier !== 'string') {
      throw new BadRequestException('stored verifier format invalid');
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
    // Assert the re
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 4000);

    try {
      const oembedPayload = await fetchYouTubeOEmbed(targetUrl);
      if (oembedPayload) {
        return oembedPayload;
      }

      let currentUrl = targetUrl;
      let response: Response | null = null;
      let redirectsCount = 0;
      const MAX_REDIRECTS = 3;

      while (redirectsCount <= MAX_REDIRECTS) {
        response = await fetch(currentUrl.toString(), {
          method: 'GET',
          redirect: 'manual', // 🔒 Empêcher les redirections automatiques
          signal: abortController.signal,
          headers: {
            'user-agent': 'CanariLinkPreview/1.0',
            accept: 'text/html,application/xhtml+xml',
          },
        });

        // Gérer manuellement les redirections
        if (response.status >= 300 && response.status <= 399) {
          const location = response.headers.get('location');
          if (!location) break;
          // 🔒 Valider la nouvelle URL cible contre les attaques SSRF (ex: redirection vers localhost)
          currentUrl = await assertSafeExternalUrl(
            new URL(location, currentUrl.href).toString(),
          );
          redirectsCount++;
        } else {
          break;
        }
      }

      if (!response || !response.ok) {
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

  @UseGuards(HeaderAuthGuard)
  @Post('mls-api/groups')
  async createGroup(
    @Body()
    body: {
      name: string;
      createdBy: string;
      isGroup?: boolean;
      creatorDeviceId?: string;
    },
  ) {
    const traceId = this.makeTraceId('create-grp');
    const groupId = uuidv4();
    this.logger.log(
      `[CREATE_GROUP][${traceId}] name="${body.name}" createdBy=${body.createdBy} isGroup=${body.isGroup ?? true} creatorDevice=${body.creatorDeviceId ?? 'none'} groupId=${groupId}`,
    );
    const newGroup = this.groupRepo.create({
      id: groupId,
      name: body.name,
      isGroup: body.isGroup ?? true,
    });
    await this.groupRepo.save(newGroup);

    // Mark the creator's device as welcome_received (they created the group locally)
    if (body.createdBy && body.creatorDeviceId) {
      const creatorMembership = this.deviceGroupRepo.create({
        userId: body.createdBy,
        deviceId: body.creatorDeviceId,
        groupId,
        status: 'welcome_received' as const,
        lastEpochSeen: 0,
      });
      await this.deviceGroupRepo.save(creatorMembership);
      this.logger.log(
        `[CREATE_GROUP][${traceId}] creator membership set to welcome_received`,
      );
    }

    this.logger.log(`[CREATE_GROUP][${traceId}] DONE groupId=${groupId}`);
    return {
      groupId,
      name: body.name,
      createdBy: body.createdBy,
      isGroup: newGroup.isGroup,
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls-api/groups/:groupId')
  async getGroup(@Param('groupId') groupId: string) {
    const g = await this.groupRepo.findOne({ where: { id: groupId } });
    this.logger.log(`[GET_GROUP] groupId=${groupId} found=${!!g}`);
    return g ? { ...g, groupId: g.id } : null;
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls-api/user-groups/:userId')
  async getUserGroups(@Param('userId') userId: string) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const memberships = await this.groupMemberRepo.find({
      where: { userId: safeUserId },
    });
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];
    if (groupIds.length === 0) {
      this.logger.log(`[USER_GROUPS] user=${safeUserId} groups=0`);
      return [];
    }
    const groups = await this.groupRepo.findByIds(groupIds);
    this.logger.log(
      `[USER_GROUPS] user=${safeUserId} groups=${groups.length} ids=${groups.map((g) => g.id).join(',')}`,
    );
    return groups.map((g) => ({
      groupId: g.id,
      name: g.name,
      isGroup: g.isGroup,
    }));
  }

  @Post('mls-api/groups/:groupId/members')
  async addGroupMember(
    @Param('groupId') groupId: string,
    @Body() body: { userId: string },
  ) {
    const traceId = this.makeTraceId('add-member');
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    this.logger.log(
      `[ADD_MEMBER][${traceId}] START group=${safeGroupId} user=${safeUserId}`,
    );

    let member = await this.groupMemberRepo.findOne({
      where: { groupId: safeGroupId, userId: safeUserId },
    });
    if (!member) {
      member = this.groupMemberRepo.create({
        groupId: safeGroupId,
        userId: safeUserId,
        joinedAt: new Date(),
      });
    } else {
      member.joinedAt = new Date();
    }
    await this.groupMemberRepo.save(member);

    // Create DeviceGroupMembership for all devices of this user
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const userDevices = await this.keyPackageRepo.find({
      where: { userId: safeUserId, createdAt: MoreThanOrEqual(cutoff) },
    });
    for (const device of userDevices) {
      const existing = await this.deviceGroupRepo.findOne({
        where: { deviceId: device.deviceId, groupId: safeGroupId },
      });
      if (!existing) {
        const membership = this.deviceGroupRepo.create({
          userId: safeUserId,
          deviceId: device.deviceId,
          groupId: safeGroupId,
          status: 'pending' as any,
        });
        await this.deviceGroupRepo.save(membership);
      }
    }

    // NB: NOT added to group:members Redis here — devices only enter the routing
    // set once welcome_sent so pre-welcome devices never receive group messages.
    this.logger.log(
      `[ADD_MEMBER][${traceId}] DONE group=${safeGroupId} user=${safeUserId} devices=${userDevices.length}`,
    );
    return { status: 'added' };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls-api/groups/:groupId/members')
  async getGroupMembers(@Param('groupId') groupId: string) {
    const g = await this.groupMemberRepo.find({ where: { groupId } });
    this.logger.log(`[GET_MEMBERS] group=${groupId} count=${g.length}`);
    return g;
  }

  @UseGuards(HeaderAuthGuard)
  @Patch('mls-api/groups/:groupId')
  async renameGroup(
    @Param('groupId') groupId: string,
    @Body() body: { name: string },
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new BadRequestException('name is required');
    }
    await this.groupRepo.update(
      { id: safeGroupId },
      { name: body.name.trim() },
    );
    this.logger.log(
      `[RENAME_GROUP] group=${safeGroupId} newName="${body.name.trim()}"`,
    );
    return { status: 'renamed' };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls-api/groups/:groupId/members/:userId')
  async removeGroupMember(
    @Param('groupId') groupId: string,
    @Param('userId') userId: string,
  ) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const safeUserId = sanitizeQueryValue(userId, 'userId');

    // Remove all per-device memberships for this user in the group to keep
    // server-side metadata aligned with the MLS remove commit semantics.
    const deviceMembershipDelete = await this.deviceGroupRepo.delete({
      groupId: safeGroupId,
      userId: safeUserId,
    });

    await this.groupMemberRepo.delete({
      groupId: safeGroupId,
      userId: safeUserId,
    });

    // Remove all devices of this user from the Redis set
    const members = await this.redis.smembers(`group:members:${safeGroupId}`);
    const toRemove = members.filter((m) => m.startsWith(`${safeUserId}:`));
    if (toRemove.length > 0) {
      await this.redis.srem(`group:members:${safeGroupId}`, ...toRemove);
    }

    this.logger.log(
      `[REMOVE_MEMBER] group=${safeGroupId} user=${safeUserId} redisRemoved=${toRemove.length} deviceMembershipsDeleted=${deviceMembershipDelete.affected ?? 0}`,
    );
    return { status: 'removed' };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls-api/groups/:groupId')
  async deleteGroup(@Param('groupId') groupId: string) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    await this.groupRepo.delete({ id: safeGroupId });
    await this.groupMemberRepo.delete({ groupId: safeGroupId });
    await this.redis.del(`group:members:${safeGroupId}`);
    this.logger.log(`[DELETE_GROUP] group=${safeGroupId}`);
    return { status: 'deleted' };
  }

  // ─── DeviceGroupMembership endpoints ──────────────────────────────────

  /**
   * Returns all pending device-group memberships for groups this device belongs to.
   * Any online device can then process these by committing Add + sending Welcome.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls-api/pending-invitations/:userId/:deviceId')
  async getPendingInvitations(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const traceId = this.makeTraceId('pending');
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    this.logger.log(
      `[PENDING][${traceId}] START user=${safeUserId} device=${safeDeviceId}`,
    );

    // 1. Get groups where this device is already a full member (welcome_received)
    const myMemberships = await this.deviceGroupRepo.find({
      where: {
        userId: safeUserId,
        deviceId: safeDeviceId,
        status: 'welcome_received' as const,
      },
    });
    const myGroupIds = myMemberships.map((m) => m.groupId);
    if (myGroupIds.length === 0) {
      this.logger.log(
        `[PENDING][${traceId}] No welcome_received membership for ${safeUserId}:${safeDeviceId}`,
      );
      return [];
    }

    // 2. Find all pending AND stale memberships in those groups
    const pending = await this.deviceGroupRepo.find({
      where: myGroupIds.flatMap((gid) => [
        { groupId: gid, status: 'pending' as const },
        { groupId: gid, status: 'stale' as const },
      ]),
    });
    this.logger.log(
      `[PENDING][${traceId}] DONE groups=${myGroupIds.length} invitations=${pending.length}`,
    );
    return pending;
  }

  /**
   * Returns all device-group memberships for a specific device (so the device
   * knows which groups it's pending/added/welcomed for).
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls-api/device-memberships/:userId/:deviceId')
  async getDeviceMemberships(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    const memberships = await this.deviceGroupRepo.find({
      where: { userId: safeUserId, deviceId: safeDeviceId },
    });
    this.logger.log(
      `[DEVICE_MEMBERSHIPS] user=${safeUserId} device=${safeDeviceId} count=${memberships.length} statuses=${memberships.map((m) => `${m.groupId}:${m.status}`).join(',')}`,
    );
    return memberships;
  }

  /**
   * Update the status of a device-group membership.
   * Transitions: pending→added, added→welcome_sent, welcome_sent→welcome_received
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls-api/invitation-status')
  async updateInvitationStatus(
    @Body()
    body: {
      deviceId: string;
      userId: string;
      groupId: string;
      status: 'pending' | 'welcome_sent' | 'welcome_received' | 'stale';
      lastEpochSeen?: number;
    },
  ) {
    const safeDeviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');

    const validStatuses = [
      'pending',
      'welcome_sent',
      'welcome_received',
      'stale',
    ];
    if (!validStatuses.includes(body.status)) {
      throw new BadRequestException(
        `status must be one of: ${validStatuses.join(', ')}`,
      );
    }

    let membership = await this.deviceGroupRepo.findOne({
      where: { deviceId: safeDeviceId, groupId: safeGroupId },
    });

    if (!membership) {
      membership = this.deviceGroupRepo.create({
        deviceId: safeDeviceId,
        userId: safeUserId,
        groupId: safeGroupId,
        status: body.status,
      });
    } else {
      membership.status = body.status;
    }

    if (
      typeof body.lastEpochSeen === 'number' &&
      Number.isFinite(body.lastEpochSeen)
    ) {
      membership.lastEpochSeen = Math.floor(body.lastEpochSeen);
    }

    await this.deviceGroupRepo.save(membership);
    this.logger.log(
      `[INVITATION_STATUS] device=${safeDeviceId} user=${safeUserId} group=${safeGroupId} newStatus=${body.status} epoch=${membership.lastEpochSeen ?? 'n/a'}`,
    );
    return { status: membership.status };
  }

  /**
   * Reset all device-group memberships of a user in a group to "pending".
   * Called by a client after it has performed the MLS remove commit for a
   * stale user.  All devices of that user are kicked and will be re-invited.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls-api/kick-stale-user')
  async kickStaleUser(@Body() body: { userId: string; groupId: string }) {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');

    const memberships = await this.deviceGroupRepo.find({
      where: { userId: safeUserId, groupId: safeGroupId },
    });

    for (const m of memberships) {
      m.status = 'pending';
      m.lastEpochSeen = 0;
    }

    if (memberships.length > 0) {
      await this.deviceGroupRepo.save(memberships);
      this.logger.log(
        `[KICK] Reset ${memberships.length} device(s) of user ${safeUserId} in group ${safeGroupId} to pending`,
      );
    }

    return {
      status: 'kicked',
      affected: memberships.length,
      devices: memberships.map((m) => ({
        deviceId: m.deviceId,
        groupId: m.groupId,
      })),
    };
  }

  @Post('mls-api/kick-stale-device')
  async kickStaleDevice(
    @Body() body: { deviceId: string; userId: string; groupId: string },
  ) {
    const safeDeviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeGroupId = sanitizeQueryValue(body.groupId, 'groupId');

    const membership = await this.deviceGroupRepo.findOne({
      where: {
        deviceId: safeDeviceId,
        userId: safeUserId,
        groupId: safeGroupId,
      },
    });

    if (!membership) {
      return { status: 'not_found', affected: 0 };
    }

    membership.status = 'pending';
    membership.lastEpochSeen = 0;
    await this.deviceGroupRepo.save(membership);

    await this.redis.srem(
      `group:members:${safeGroupId}`,
      `${safeUserId}:${safeDeviceId}`,
    );

    this.logger.log(
      `[KICK] Reset device ${safeDeviceId} of user ${safeUserId} in group ${safeGroupId} to pending`,
    );

    return { status: 'kicked', affected: 1, deviceId: safeDeviceId };
  }

  /**
   * Delete a specific device-group membership (e.g. when removing a device).
   * Also deletes ALL memberships for the device if no groupId is provided.
   */
  @UseGuards(HeaderAuthGuard)
  @Delete('mls-api/device-memberships/:userId/:deviceId/:groupId')
  async deleteDeviceMembership(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Param('groupId') groupId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');

    const result = await this.deviceGroupRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
      groupId: safeGroupId,
    });

    // Keep Redis message routing in sync with membership deletion.
    await this.redis.srem(
      `group:members:${safeGroupId}`,
      `${safeUserId}:${safeDeviceId}`,
    );

    this.logger.log(
      `[DEL_MEMBERSHIP] user=${safeUserId} device=${safeDeviceId} group=${safeGroupId} affected=${result.affected ?? 0}`,
    );
    return { status: 'deleted', affected: result.affected ?? 0 };
  }

  /**
   * Delete ALL device-group memberships for a specific device.
   */
  @UseGuards(HeaderAuthGuard)
  @Delete('mls-api/device-memberships/:userId/:deviceId')
  async deleteAllDeviceMemberships(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');

    // Capture affected groups before delete so we can clean Redis routing sets.
    const memberships = await this.deviceGroupRepo.find({
      where: { userId: safeUserId, deviceId: safeDeviceId },
      select: ['groupId'],
    });
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];

    const result = await this.deviceGroupRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
    });

    const memberKey = `${safeUserId}:${safeDeviceId}`;
    for (const gid of groupIds) {
      await this.redis.srem(`group:members:${gid}`, memberKey);
    }

    this.logger.log(
      `[DEL_ALL_MEMBERSHIPS] user=${safeUserId} device=${safeDeviceId} affected=${result.affected ?? 0} redisGroupsCleaned=${groupIds.length}`,
    );
    return { status: 'deleted', affected: result.affected ?? 0 };
  }

  /**
   * Completely delete a device from the user's account.
   * Removes: all group memberships, KeyPackages, OneTimeKeyPackages, and push tokens.
   */
  @UseGuards(HeaderAuthGuard)
  @Delete('mls-api/devices/:userId/:deviceId')
  async deleteDevice(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');

    // 1. Remove from ALL groups and clean Redis
    const memberships = await this.deviceGroupRepo.find({
      where: { userId: safeUserId, deviceId: safeDeviceId },
      select: ['groupId'],
    });
    const groupIds = [...new Set(memberships.map((m) => m.groupId))];

    await this.deviceGroupRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
    });

    const memberKey = `${safeUserId}:${safeDeviceId}`;
    for (const gid of groupIds) {
      await this.redis.srem(`group:members:${gid}`, memberKey);
    }

    // 2. Delete all KeyPackages for this device
    const kpResult = await this.keyPackageRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
    });

    // 3. Delete all OneTimeKeyPackages for this device
    const otkpResult = await this.oneTimeKeyPackageRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
    });

    // 4. Delete push token if exists
    await this.pushTokenRepo.delete({
      userId: safeUserId,
      deviceId: safeDeviceId,
    });

    this.logger.log(
      `[DELETE_DEVICE] user=${safeUserId} device=${safeDeviceId} groupsCleaned=${groupIds.length} keyPackagesDeleted=${kpResult.affected ?? 0} oneTimeKeyPackagesDeleted=${otkpResult.affected ?? 0}`,
    );

    return {
      status: 'device_deleted',
      groupsCleaned: groupIds.length,
      keyPackagesDeleted: kpResult.affected ?? 0,
      oneTimeKeyPackagesDeleted: otkpResult.affected ?? 0,
    };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls-api/devices/:userId/:deviceId/prekeys/count')
  async getPrekeyCount(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');
    const count = await this.oneTimeKeyPackageRepo.count({
      where: { userId: safeUserId, deviceId: safeDeviceId },
    });
    return { count };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls-api/register-device/prekeys')
  async registerDevicePrekeys(
    @Body() body: { userId: string; deviceId: string; keyPackages: unknown },
  ) {
    const userId = sanitizeQueryValue(body.userId, 'userId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');

    if (!Array.isArray(body.keyPackages) || body.keyPackages.length === 0) {
      throw new BadRequestException('keyPackages must be a non-empty array');
    }
    if (body.keyPackages.length > 200) {
      throw new BadRequestException('keyPackages must not exceed 200 items');
    }
    for (const kp of body.keyPackages) {
      if (typeof kp !== 'string' || kp.length === 0 || kp.length > 16384) {
        throw new BadRequestException(
          'Each keyPackage must be a non-empty base64 string',
        );
      }
    }

    const rows = (body.keyPackages as string[]).map((kp) =>
      this.oneTimeKeyPackageRepo.create({ userId, deviceId, keyPackage: kp }),
    );
    await this.oneTimeKeyPackageRepo.save(rows);
    this.logger.log(
      `[REGISTER_PREKEYS] user=${userId} device=${deviceId} count=${rows.length}`,
    );
    return { status: 'registered', count: rows.length };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls-api/register-device')
  async registerDevice(
    @Body() body: { userId: string; deviceId: string; keyPackage: string },
  ) {
    const traceId = this.makeTraceId('reg-device');
    this.logger.log(
      `[REGISTER_DEVICE][${traceId}] START user=${body.userId} device=${body.deviceId} kpLen=${body.keyPackage?.length ?? 0}`,
    );
    let keyPackage = await this.keyPackageRepo.findOne({
      where: { userId: body.userId, deviceId: body.deviceId },
    });
    const isNew = !keyPackage;
    if (!keyPackage) {
      keyPackage = this.keyPackageRepo.create({
        userId: body.userId,
        deviceId: body.deviceId,
        keyPackage: body.keyPackage,
        createdAt: new Date(),
      });
    } else {
      keyPackage.keyPackage = body.keyPackage;
      keyPackage.createdAt = new Date();
    }
    await this.keyPackageRepo.save(keyPackage);

    // Create pending DeviceGroupMembership entries for all groups this user
    // already belongs to.  Without this, getPendingInvitations on other
    // devices won't see the new device and will never send it a Welcome.
    const userGroups = await this.groupMemberRepo.find({
      where: { userId: body.userId },
    });
    for (const gm of userGroups) {
      const existing = await this.deviceGroupRepo.findOne({
        where: { deviceId: body.deviceId, groupId: gm.groupId },
      });
      if (!existing) {
        const membership = this.deviceGroupRepo.create({
          userId: body.userId,
          deviceId: body.deviceId,
          groupId: gm.groupId,
          status: 'pending' as const,
        });
        await this.deviceGroupRepo.save(membership);
      }
    }

    this.logger.log(
      `[REGISTER_DEVICE][${traceId}] DONE user=${body.userId} device=${body.deviceId} isNew=${isNew} pendingGroups=${userGroups.length}`,
    );
    return { status: 'registered' };
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls-api/devices/:userId')
  async getUserDevices(@Param('userId') userId: string) {
    // Only return devices active in the last 30 days (avoids stale key packages)
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const registeredDevices = await this.keyPackageRepo.find({
      where: { userId, createdAt: MoreThanOrEqual(cutoff) },
      order: { createdAt: 'DESC' },
    });

    // For each device, try to pop one one-time prekey from the pool (FIFO).
    // Falls back to the static registration key package when the pool is empty.
    const results = await Promise.all(
      registeredDevices.map(async (device) => {
        const otkp = await this.oneTimeKeyPackageRepo.findOne({
          where: { userId: device.userId, deviceId: device.deviceId },
          order: { createdAt: 'ASC' },
        });
        if (otkp) {
          await this.oneTimeKeyPackageRepo.delete(otkp.id);
          return { ...device, keyPackage: otkp.keyPackage };
        }
        // Pool exhausted — serve the static registration KP as a fallback, never delete it.
        return device;
      }),
    );

    return results;
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls-api/add-lock')
  async acquireAddLock(
    @Body()
    body: {
      groupId: string;
      deviceId: string;
      ttlMs?: number;
    },
  ) {
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const ttlSec = Math.max(
      1,
      Math.min(30, Math.round((body.ttlMs ?? 10_000) / 1000)),
    );
    // Redis SET NX EX : acquiert le verrou seulement si la clé n'existe pas encore
    const lockKey = `mls:addlock:${groupId}`;
    const result = await this.redis.set(lockKey, deviceId, 'EX', ttlSec, 'NX');
    this.logger.log(
      `[ADD_LOCK] group=${groupId} device=${deviceId} acquired=${result === 'OK'} ttl=${ttlSec}s`,
    );
    return { acquired: result === 'OK' };
  }

  @UseGuards(HeaderAuthGuard)
  @Delete('mls-api/add-lock')
  async releaseAddLock(@Body() body: { groupId: string; deviceId: string }) {
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const lockKey = `mls:addlock:${groupId}`;
    // Libérer seulement si c'est ce deviceId qui détient le verrou
    const holder = await this.redis.get(lockKey);
    if (holder === deviceId) {
      await this.redis.del(lockKey);
    }
    this.logger.log(
      `[RELEASE_LOCK] group=${groupId} device=${deviceId} released=${holder === deviceId} holder=${holder ?? 'none'}`,
    );
    return { released: holder === deviceId };
  }

  /**
   * Reset a group's activeEpoch to 0.
   * Called during re-bootstrap when a new MLS session replaces the old one
   * for the same server groupId. Without this reset the first commit would
   * be rejected because the server still remembers the old epoch.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls-api/groups/:groupId/reset-epoch')
  async resetGroupEpoch(@Param('groupId') groupId: string) {
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const group = await this.groupRepo.findOne({ where: { id: safeGroupId } });
    if (!group) {
      this.logger.warn(`[RESET_EPOCH] Group not found: ${safeGroupId}`);
      throw new BadRequestException(`Group ${safeGroupId} not found`);
    }
    const oldEpoch = group.activeEpoch;
    group.activeEpoch = 0;
    await this.groupRepo.save(group);
    this.logger.log(
      `[RESET_EPOCH] group=${safeGroupId} oldEpoch=${oldEpoch} → 0`,
    );
    return { groupId: safeGroupId, activeEpoch: 0 };
  }

  /**
   * ─── Group Reset (hors-bande MLS) ────────────────────────────────────
   *
   * Signale à tous les appareils d'un groupe que la session MLS est morte
   * et doit être recréée from scratch. Contrairement au bootstrap client-side
   * qui écrasait unilatéralement le groupe (source de forks d'epoch),
   * ce reset est **orchestré par le serveur** :
   *
   *   1. Toutes les DeviceGroupMembership passent à "pending"
   *   2. L'epoch serveur est reset à 0
   *   3. Le set Redis group:members est vidé (plus de routage)
   *   4. **Un message WebSocket `group_reset` est diffusé** à tout appareil
   *      en ligne → chaque client fait forgetGroup() + isReady=false
   *   5. À la prochaine (re)connexion, chaque appareil enverra un
   *      welcome_request et sera ré-invité par le bootstrapper
   *
   * Le message `group_reset` est un signal hors-bande (non chiffré, pas de
   * dépendance MLS/KeyPackage). Il suit le même pattern que welcome_request
   * et reinvite_request : JSON sur Redis pub/sub → WebSocket.
   *
   * ⚠️ Modèle de menace : un serveur compromis pourrait forcer un reset.
   * C'est déjà le cas avec reinvite_request et la gestion des memberships —
   * le modèle fait confiance au serveur pour le routage.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls-api/groups/:groupId/reset')
  async resetGroup(
    @Param('groupId') groupId: string,
    @Body() body: { reason?: string; triggeredBy?: string },
  ) {
    const traceId = this.makeTraceId('group-reset');
    const safeGroupId = sanitizeQueryValue(groupId, 'groupId');
    const reason = body.reason ?? 'bootstrap';
    const triggeredBy =
      sanitizeOptionalQueryValue(body.triggeredBy, 'triggeredBy') ?? 'unknown';

    const group = await this.groupRepo.findOne({
      where: { id: safeGroupId },
    });
    if (!group) {
      throw new BadRequestException(`Group ${safeGroupId} not found`);
    }

    this.logger.log(
      `[GROUP_RESET][${traceId}] START group=${safeGroupId} reason=${reason} triggeredBy=${triggeredBy} oldEpoch=${group.activeEpoch}`,
    );

    // ── 1. Reset toutes les memberships à "pending" ────────────────────
    // Chaque appareil devra être ré-invité via welcome_request.
    const memberships = await this.deviceGroupRepo.find({
      where: { groupId: safeGroupId },
    });
    for (const m of memberships) {
      m.status = 'pending';
      m.lastEpochSeen = 0;
    }
    if (memberships.length > 0) {
      await this.deviceGroupRepo.save(memberships);
    }
    this.logger.log(
      `[GROUP_RESET][${traceId}] ${memberships.length} membership(s) reset to pending`,
    );

    // ── 2. Reset epoch serveur ─────────────────────────────────────────
    group.activeEpoch = 0;
    await this.groupRepo.save(group);

    // ── 3. Vider le set Redis de routage ───────────────────────────────
    // Plus aucun appareil ne doit recevoir de messages MLS pour ce groupe
    // tant qu'il n'a pas été ré-invité.
    const redisKey = `group:members:${safeGroupId}`;
    const currentMembers: string[] = await this.redis.smembers(redisKey);
    if (currentMembers.length > 0) {
      await this.redis.del(redisKey);
    }
    this.logger.log(
      `[GROUP_RESET][${traceId}] Redis routing cleared (was ${currentMembers.length} member(s))`,
    );

    // ── 4. Diffuser group_reset à tous les appareils en ligne ──────────
    // On utilise la liste qu'on vient de vider (currentMembers) car ces
    // appareils avaient encore la connexion WebSocket active.
    const notification = JSON.stringify({
      type: 'group_reset',
      groupId: safeGroupId,
      reason,
      triggeredBy,
    });

    let notifiedCount = 0;
    for (const member of currentMembers) {
      const [memberUserId, memberDeviceId] = member.split(':');
      if (!memberUserId || !memberDeviceId) continue;

      const onlineKey = `user:online:${memberUserId}:${memberDeviceId}`;
      const isOnline = await this.redis.exists(onlineKey);
      if (isOnline) {
        await this.redis.publish(
          'chat:messages',
          JSON.stringify({
            recipientId: memberUserId,
            deviceId: memberDeviceId,
            proto: Buffer.from(notification).toString('base64'),
            groupId: safeGroupId,
            // Pas isWelcome, pas isCommit : le gateway relaye le JSON brut
            // comme un control frame, identique à welcome_request.
          }),
        );
        notifiedCount++;
      }
    }

    this.logger.log(
      `[GROUP_RESET][${traceId}] DONE group=${safeGroupId} notified=${notifiedCount}/${currentMembers.length} memberships=${memberships.length}`,
    );

    return {
      status: 'reset',
      groupId: safeGroupId,
      membershipsReset: memberships.length,
      notified: notifiedCount,
    };
  }

  /**
   * Epoch-gated commit: validates that the sender's baseEpoch matches the
   * group's activeEpoch before allowing the commit through.
   * Prevents MLS epoch forks caused by concurrent commits from multiple devices.
   *
   * Returns:
   * - 200 { accepted: true, newEpoch } on success (activeEpoch incremented)
   * - 200 { accepted: false, currentEpoch } when baseEpoch doesn't match (stale sender)
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls-api/commit')
  async validateCommit(
    @Body()
    body: {
      groupId: string;
      deviceId: string;
      baseEpoch: number;
    },
  ) {
    const traceId = this.makeTraceId('commit');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const baseEpoch =
      typeof body.baseEpoch === 'number' && Number.isFinite(body.baseEpoch)
        ? Math.floor(body.baseEpoch)
        : -1;

    if (baseEpoch < 0) {
      this.logger.warn(
        `[COMMIT][${traceId}] Invalid baseEpoch=${body.baseEpoch} group=${groupId} device=${deviceId}`,
      );
      throw new BadRequestException('baseEpoch must be a non-negative integer');
    }

    this.logger.log(
      `[COMMIT][${traceId}] START group=${groupId} device=${deviceId} baseEpoch=${baseEpoch}`,
    );

    // Serialize via Redis lock to prevent TOCTOU races.
    // Two devices sending commits at the same epoch would both read the same
    // activeEpoch — the lock ensures only one gets through.
    const lockKey = `mls:commitlock:${groupId}`;
    const lockAcquired = await this.redis.set(lockKey, deviceId, 'EX', 5, 'NX');
    if (lockAcquired !== 'OK') {
      // Another commit is being validated right now — reject to retry.
      const group = await this.groupRepo.findOne({ where: { id: groupId } });
      this.logger.warn(
        `[COMMIT][${traceId}] REJECT concurrent_commit group=${groupId} currentEpoch=${group?.activeEpoch ?? 0}`,
      );
      return {
        accepted: false,
        currentEpoch: group?.activeEpoch ?? 0,
        reason: 'concurrent_commit',
      };
    }

    try {
      const group = await this.groupRepo.findOne({ where: { id: groupId } });
      if (!group) {
        this.logger.error(`[COMMIT][${traceId}] Group not found: ${groupId}`);
        throw new BadRequestException(`Group ${groupId} not found`);
      }

      // When activeEpoch is 0 the server has no prior tracking for this group
      // (e.g. all previous commit validations failed with HTTP 400 due to the
      // old userId:deviceId length bug).  Treat this as "uninitialized" and
      // fast-forward to baseEpoch + 1 so the client state and server state
      // converge without requiring a full re-bootstrap.
      if (baseEpoch !== group.activeEpoch && group.activeEpoch !== 0) {
        this.logger.warn(
          `[COMMIT][${traceId}] REJECT epoch_mismatch group=${groupId} baseEpoch=${baseEpoch} activeEpoch=${group.activeEpoch}`,
        );
        return {
          accepted: false,
          currentEpoch: group.activeEpoch,
          reason: 'epoch_mismatch',
        };
      }

      // Advance the epoch (from wherever the server currently is)
      group.activeEpoch = baseEpoch + 1;
      await this.groupRepo.save(group);

      this.logger.log(
        `[COMMIT][${traceId}] ACCEPT group=${groupId} newEpoch=${group.activeEpoch}`,
      );

      return { accepted: true, newEpoch: group.activeEpoch };
    } finally {
      // Always release the commit lock
      const holder = await this.redis.get(lockKey);
      if (holder === deviceId) {
        await this.redis.del(lockKey);
        this.logger.log(
          `[COMMIT][${traceId}] Lock released for group=${groupId}`,
        );
      } else {
        this.logger.warn(
          `[COMMIT][${traceId}] Lock holder changed (holder=${holder ?? 'none'}) for group=${groupId}`,
        );
      }
    }
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls-api/welcome-request')
  async notifyWelcomeRequest(
    @Body()
    body: {
      groupId: string;
      requesterUserId: string;
      requesterDeviceId: string;
    },
  ) {
    const traceId = this.makeTraceId('welcome-req');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const requesterUserId = sanitizeQueryValue(
      body.requesterUserId,
      'requesterUserId',
    );
    const requesterDeviceId = sanitizeQueryValue(
      body.requesterDeviceId,
      'requesterDeviceId',
    );

    // Atomically pick one online group member that is not the requester.
    // Using a single server-side selection avoids the multi-connection race that
    // occurs when the gateway forwards the WS frame: each concurrent connection
    // from the requester's device would call forward_to_one_peer independently,
    // and since SMEMBERS returns an unordered set each call can pick a different
    // peer, causing multiple devices to concurrently commit an add for the same
    // invitation.
    const members: string[] = await this.redis.smembers(
      `group:members:${groupId}`,
    );
    const senderKey = `${requesterUserId}:${requesterDeviceId}`;

    this.logger.log(
      `[WELCOME_REQ][${traceId}] START group=${groupId} requester=${senderKey} members=${members.length}`,
    );

    const notification = JSON.stringify({
      type: 'welcome_request',
      groupId,
      requesterUserId,
      requesterDeviceId,
    });

    for (const member of members) {
      if (member === senderKey) continue;
      const [memberUserId, memberDeviceId] = member.split(':');
      if (!memberUserId || !memberDeviceId) {
        this.logger.warn(
          `[WELCOME_REQ][${traceId}] Malformed group member entry='${member}' group=${groupId}`,
        );
        continue;
      }
      const onlineKey = `user:online:${memberUserId}:${memberDeviceId}`;
      const isOnline = await this.redis.exists(onlineKey);
      this.logger.log(
        `[WELCOME_REQ][${traceId}] Candidate=${member} online=${!!isOnline}`,
      );
      if (isOnline) {
        await this.redis.publish(
          'chat:messages',
          JSON.stringify({
            recipientId: memberUserId,
            deviceId: memberDeviceId,
            // Re-use the proto field as a JSON-encoded control payload so the
            // gateway can relay it as a plain text WS frame without extra decoding.
            proto: Buffer.from(notification).toString('base64'),
            isWelcomeRequest: true,
            groupId,
            senderId: requesterUserId,
            senderDeviceId: requesterDeviceId,
          }),
        );
        this.logger.log(
          `[WELCOME_REQ][${traceId}] FORWARDED target=${member} group=${groupId} requester=${senderKey}`,
        );
        return { status: 'forwarded', target: member };
      }
    }

    this.logger.log(
      `[WELCOME_REQ][${traceId}] NO_PEER_ONLINE group=${groupId} requester=${senderKey} — processPendingInvitations on next connect`,
    );
    return { status: 'no_peer_online' };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls-api/reinvite-request')
  async notifyReinviteRequest(
    @Body()
    body: {
      groupId: string;
      requesterUserId: string;
      requesterDeviceId: string;
    },
  ) {
    const traceId = this.makeTraceId('reinvite-req');
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const requesterUserId = sanitizeQueryValue(
      body.requesterUserId,
      'requesterUserId',
    );
    const requesterDeviceId = sanitizeQueryValue(
      body.requesterDeviceId,
      'requesterDeviceId',
    );

    const members: string[] = await this.redis.smembers(
      `group:members:${groupId}`,
    );
    const senderKey = `${requesterUserId}:${requesterDeviceId}`;

    this.logger.log(
      `[REINVITE_REQ][${traceId}] START group=${groupId} requester=${senderKey} members=${members.length}`,
    );

    const notification = JSON.stringify({
      type: 'reinvite_request',
      groupId,
      senderId: requesterUserId,
      senderDeviceId: requesterDeviceId,
    });

    for (const member of members) {
      if (member === senderKey) continue;
      const [memberUserId, memberDeviceId] = member.split(':');
      if (!memberUserId || !memberDeviceId) {
        this.logger.warn(
          `[REINVITE_REQ][${traceId}] Malformed group member entry='${member}' group=${groupId}`,
        );
        continue;
      }
      const onlineKey = `user:online:${memberUserId}:${memberDeviceId}`;
      const isOnline = await this.redis.exists(onlineKey);
      this.logger.log(
        `[REINVITE_REQ][${traceId}] Candidate=${member} online=${!!isOnline}`,
      );
      if (isOnline) {
        await this.redis.publish(
          'chat:messages',
          JSON.stringify({
            recipientId: memberUserId,
            deviceId: memberDeviceId,
            proto: Buffer.from(notification).toString('base64'),
            isReinviteRequest: true,
            groupId,
            senderId: requesterUserId,
            senderDeviceId: requesterDeviceId,
          }),
        );
        this.logger.log(
          `[REINVITE_REQ][${traceId}] FORWARDED target=${member} group=${groupId} requester=${senderKey}`,
        );
        return { status: 'forwarded', target: member };
      }
    }

    this.logger.log(
      `[REINVITE_REQ][${traceId}] NO_PEER_ONLINE group=${groupId} requester=${senderKey} — retry on next connect`,
    );
    return { status: 'no_peer_online' };
  }

  @UseGuards(HeaderAuthGuard)
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
    const traceId = this.makeTraceId('welcome-send');
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

    this.logger.log(
      `[WELCOME][${traceId}] START group=${safeGroupId} sender=${senderUserId} target=${targetUserId ?? 'unknown'}:${targetDeviceId} payloadLen=${body.welcomePayload?.length ?? 0} ratchetTreeLen=${body.ratchetTreePayload?.length ?? 0}`,
    );

    // Look up recipient device — include userId in the query when provided so the lookup
    // is unambiguous even if two users happen to share the same raw device ID string
    // (common in same-browser multi-tab testing).
    const query: Record<string, string> = { deviceId: targetDeviceId };
    if (targetUserId) {
      query.userId = targetUserId;
    }
    const deviceInfo = await this.keyPackageRepo.findOne({ where: query });

    if (!deviceInfo) {
      this.logger.error(
        `[WELCOME][${traceId}] Target device not found target=${targetUserId ?? 'unknown'}:${targetDeviceId}`,
      );
      throw new Error(
        `Device ${targetDeviceId} (user: ${targetUserId ?? 'unknown'}) not found. Cannot deliver Welcome message.`,
      );
    }

    const queuedWelcome = this.queuedMessageRepo.create({
      recipientId: deviceInfo.userId,
      deviceId: targetDeviceId,
      senderId: senderUserId,
      groupId: safeGroupId,
      proto: body.welcomePayload,
      isWelcome: true,
      ratchetTree: body.ratchetTreePayload,
      createdAt: new Date(),
    });
    await this.queuedMessageRepo.save(queuedWelcome);
    this.logger.log(
      `[WELCOME][${traceId}] QUEUED id=${queuedWelcome.id} recipient=${deviceInfo.userId}:${targetDeviceId} group=${safeGroupId}`,
    );

    // Real-time push via Gateway when the target device is currently online.
    const redisKey = `user:online:${deviceInfo.userId}:${targetDeviceId}`;
    const isOnline = await this.redis.exists(redisKey);
    this.logger.log(
      `[WELCOME][${traceId}] PRESENCE key=${redisKey} online=${!!isOnline}`,
    );
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
      this.logger.log(
        `[WELCOME][${traceId}] REALTIME_PUBLISH key=${redisKey} envelopeLen=${envelope.length}`,
      );
      await this.redis.publish('chat:messages', envelope);
      this.logger.log(
        `[WELCOME][${traceId}] REALTIME_PUBLISHED key=${redisKey} queuedId=${queuedWelcome.id}`,
      );
    } else {
      this.logger.log(
        `[WELCOME][${traceId}] OFFLINE_ONLY key=${redisKey} queuedId=${queuedWelcome.id}`,
      );
    }

    // Update DeviceGroupMembership status to welcome_sent
    await this.deviceGroupRepo
      .createQueryBuilder()
      .update()
      .set({ status: 'welcome_sent' as const })
      .where(
        'deviceId = :deviceId AND groupId = :groupId AND status = :status',
        {
          deviceId: targetDeviceId,
          groupId: safeGroupId,
          status: 'pending',
        },
      )
      .execute();

    // Device can now decrypt — add it to the routing set.
    await this.redis.sadd(
      `group:members:${safeGroupId}`,
      `${deviceInfo.userId}:${targetDeviceId}`,
    );

    this.logger.log(
      `[WELCOME][${traceId}] DONE group=${safeGroupId} target=${deviceInfo.userId}:${targetDeviceId}`,
    );

    return { status: 'queued' };
  }

  @UseGuards(HeaderAuthGuard)
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
      isCommit?: boolean;
      /** userId:deviceId pairs to skip (e.g. invitee already receiving a Welcome) */
      excludeDeviceIds?: string[];
      // legacy fields (frontend fallback / group fan-out)
      content?: string;
      type?: string;
    },
  ) {
    const traceId = this.makeTraceId('send');
    // ── Queue-first delivery ──────────────────────────────────────────────
    // Every message is persisted first so it survives timing races between
    // the online-check and the actual WebSocket send.  After queuing we
    // attempt real-time delivery via Redis pub/sub; the client ACKs by
    // queuedMessageId which deletes the entry from the queue.

    const ops: QueuedMessage[] = [];
    let sentCount = 0;

    this.logger.log(
      `[SEND][${traceId}] START group=${body.groupId ?? 'none'} sender=${body.senderId ?? 'unknown'}:${body.senderDeviceId ?? 'unknown'} hasProto=${!!body.proto} recipients=${body.recipients?.length ?? 0} isWelcome=${!!body.isWelcome} isCommit=${!!body.isCommit}`,
    );

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
        ops.push(
          this.queuedMessageRepo.create({
            recipientId: recipientUserId,
            deviceId: recipientDeviceId,
            senderId: body.senderId,
            senderDeviceId: body.senderDeviceId,
            groupId: body.groupId,
            isWelcome: body.isWelcome,
            isCommit: body.isCommit,
            proto,
            createdAt: new Date(),
          }),
        );
      }

      // ── Fallback: recipients not provided (Redis cache miss) ─────────────
      // Resolve from DB and repopulate group:members so subsequent messages
      // no longer need this round-trip.
      if (ops.length === 0 && body.groupId) {
        const fallbackGroupId = body.groupId;
        const memberships = await this.deviceGroupRepo.find({
          where: {
            groupId: fallbackGroupId,
            status: In(['welcome_sent', 'welcome_received']),
          },
        });
        const excludeSet = new Set<string>(body.excludeDeviceIds ?? []);
        const fallback = memberships.filter(
          (m) =>
            !(
              m.userId === body.senderId && m.deviceId === body.senderDeviceId
            ) && !excludeSet.has(`${m.userId}:${m.deviceId}`),
        );
        for (const m of fallback) {
          ops.push(
            this.queuedMessageRepo.create({
              recipientId: m.userId,
              deviceId: m.deviceId,
              senderId: body.senderId,
              senderDeviceId: body.senderDeviceId,
              groupId: fallbackGroupId,
              isWelcome: body.isWelcome,
              isCommit: body.isCommit,
              proto,
              createdAt: new Date(),
            }),
          );
        }
        if (fallback.length > 0) {
          await this.redis.sadd(
            `group:members:${fallbackGroupId}`,
            ...fallback.map((m) => `${m.userId}:${m.deviceId}`),
          );
          this.logger.log(
            `[SEND][${traceId}] FALLBACK_MEMBERS_CACHE group=${fallbackGroupId} count=${fallback.length}`,
          );
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
      const rawContent: unknown = body.content;
      const rawType: unknown = body.type;

      if (typeof rawContent !== 'string' || rawContent.length === 0) {
        throw new BadRequestException('content is required');
      }

      const safeContent: string = rawContent;
      const safeType: string =
        typeof rawType === 'string' && rawType.length > 0 ? rawType : 'message';

      const targetList: { userId: string; deviceId: string }[] = [];

      if (!body.recipients || body.recipients.length === 0) {
        const members = await this.groupMemberRepo.find({ where: { groupId } });
        const memberUserIds = members
          .map((m) => m.userId)
          .filter((id) => id !== senderId);

        if (memberUserIds.length > 0) {
          const devices = await this.keyPackageRepo.find({
            where: { userId: In(memberUserIds) },
          });
          for (const d of devices) {
            targetList.push({ userId: d.userId, deviceId: d.deviceId });
          }
        }
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
        ops.push(
          this.queuedMessageRepo.create({
            recipientId: r.userId,
            deviceId: r.deviceId,
            senderId,
            senderDeviceId,
            groupId,
            content: safeContent,
            type: safeType,
            createdAt: new Date(),
          }),
        );
      }
    }

    // 1. Persist ALL messages first (survives crashes / timing races)
    if (ops.length > 0) {
      await this.queuedMessageRepo.save(ops);
      this.logger.log(`[SEND][${traceId}] QUEUED count=${ops.length}`);
    } else {
      this.logger.warn(`[SEND][${traceId}] No message queued after validation`);
    }

    // 2. Best-effort real-time delivery for online recipients
    for (const queued of ops) {
      const redisKey = `user:online:${queued.recipientId}:${queued.deviceId}`;
      const isOnline = await this.redis.exists(redisKey);
      this.logger.log(
        `[SEND][${traceId}] recipient=${queued.recipientId}:${queued.deviceId} online=${!!isOnline} queuedId=${queued.id}`,
      );
      if (isOnline) {
        const envelope = JSON.stringify({
          recipientId: queued.recipientId,
          deviceId: queued.deviceId,
          senderId: body.senderId ?? '',
          senderDeviceId: body.senderDeviceId ?? '',
          groupId: body.groupId ?? '',
          isWelcome: body.isWelcome ?? false,
          isCommit: body.isCommit ?? false,
          proto: queued.proto ?? queued.content ?? '',
          queuedMessageId: queued.id,
        });
        await this.redis.publish('chat:messages', envelope);
        sentCount++;
        this.logger.log(
          `[SEND][${traceId}] PUBLISHED recipient=${queued.recipientId}:${queued.deviceId} queuedId=${queued.id}`,
        );
      } else if (!body.isWelcome && !body.isCommit && admin.apps.length > 0) {
        // Offline recipient: send FCM push notification
        const pushTokens = await this.pushTokenRepo.find({
          where: { userId: queued.recipientId },
        });
        for (const pt of pushTokens) {
          try {
            await admin.messaging().send({
              token: pt.token,
              // Pas de clé "notification" → data-only push, onMessageReceived()
              // est toujours appelé (foreground ET background).
              data: {
                type: 'message',
                groupId: body.groupId ?? '',
                queuedMessageId: queued.id,
                senderId: body.senderId ?? '',
              },
              android: { priority: 'high' },
              apns: {
                payload: { aps: { contentAvailable: true, sound: 'default' } },
              },
            });
            this.logger.log(
              `[PUSH_SEND][${traceId}] FCM sent user=${queued.recipientId} device=${pt.deviceId}`,
            );
          } catch (e) {
            this.logger.warn(
              `[PUSH_SEND][${traceId}] FCM failed user=${queued.recipientId} device=${pt.deviceId} err=${e}`,
            );
          }
        }
      }
    }

    this.logger.log(
      `[SEND][${traceId}] DONE queued=${ops.length} realtime=${sentCount}`,
    );

    return { status: 'processed', queued: ops.length, sent: sentCount };
  }

  @Get('history/:groupId')
  async getHistory(
    @Param('groupId') groupId: string,
    @Query('after') after?: string,
  ): Promise<Record<string, unknown>[]> {
    const streamKey = `history:${groupId}`;
    try {
      // `after` = exclusive Redis stream ID (e.g. "1712345678901-0").
      // Using `(${after}` makes XRANGE exclusive (skips the entry itself).
      const startId = after ? `(${after}` : '-';
      const entries = await this.redis.xrange(streamKey, startId, '+');
      this.logger.log(
        `[HISTORY] group=${groupId} after=${after ?? 'start'} entries=${entries.length}`,
      );
      return entries.map(([id, fields]) => {
        const msg: Record<string, unknown> = { id };
        for (let i = 0; i < fields.length; i += 2) {
          msg[fields[i]] = fields[i + 1];
        }
        return msg;
      });
    } catch (e) {
      this.logger.error(`[HISTORY] group=${groupId} error=${e}`);
      return [];
    }
  }

  @Get('mls-api/messages/:userId/:deviceId')
  async fetchMessages(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
  ) {
    const traceId = this.makeTraceId('fetch-msg');
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(deviceId, 'deviceId');

    this.logger.log(
      `[MSG_FETCH][${traceId}] START user=${safeUserId} device=${safeDeviceId}`,
    );

    // On renvoie juste la liste
    const messages = await this.queuedMessageRepo.find({
      where: { recipientId: safeUserId, deviceId: safeDeviceId },
      order: { createdAt: 'ASC' },
    });
    this.logger.log(
      `[MSG_FETCH][${traceId}] DONE user=${safeUserId} device=${safeDeviceId} count=${messages.length}`,
    );
    return messages;
  }

  // 2. Nouvelle route d'Acquittement (ACK)
  @Post('mls-api/messages/ack')
  async acknowledgeMessages(
    @Body() body: { userId: string; deviceId: string; messageIds: string[] },
  ) {
    const traceId = this.makeTraceId('ack');
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    const safeDeviceId = sanitizeQueryValue(body.deviceId, 'deviceId');
    const safeMessageIds = sanitizeStringIdList(body.messageIds);

    this.logger.log(
      `[ACK][${traceId}] START user=${safeUserId} device=${safeDeviceId} requested=${safeMessageIds.length}`,
    );

    if (safeMessageIds.length === 0) {
      this.logger.warn(
        `[ACK][${traceId}] IGNORE empty messageIds user=${safeUserId} device=${safeDeviceId}`,
      );
      return { status: 'ignored' };
    }

    // On supprime uniquement les messages que le client a confirmés
    const result = await this.queuedMessageRepo.delete({
      id: In(safeMessageIds),
      recipientId: safeUserId,
      deviceId: safeDeviceId, // Sécurité pour éviter qu'un device supprime les messages d'un autre
    });

    this.logger.log(
      `[ACK][${traceId}] DONE deleted=${result.affected || 0} user=${safeUserId} device=${safeDeviceId}`,
    );

    return { status: 'deleted', count: result.affected || 0 };
  }

  // ─── Push Notification token management ───────────────────────────────

  /**
   * Register or refresh a push token for a device.
   * Upserts on (userId, deviceId) — one token per device per user.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('push/register')
  async registerPushToken(
    @Body() body: { token: string; deviceId: string; platform?: string },
    @Headers('x-user-id') userIdRaw: string,
  ) {
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const deviceId = sanitizeQueryValue(body.deviceId, 'deviceId');

    if (typeof body.token !== 'string' || !body.token.trim()) {
      throw new BadRequestException('token is required');
    }
    const token = body.token.trim().slice(0, 500);
    const platform: 'android' | 'ios' =
      body.platform === 'ios' ? 'ios' : 'android';

    let pushToken = await this.pushTokenRepo.findOne({
      where: { userId, deviceId },
    });

    if (!pushToken) {
      pushToken = this.pushTokenRepo.create({
        userId,
        deviceId,
        token,
        platform,
      });
    } else {
      pushToken.token = token;
      pushToken.platform = platform;
    }

    await this.pushTokenRepo.save(pushToken);
    this.logger.log(
      `[PUSH_REGISTER] user=${userId} device=${deviceId} platform=${platform}`,
    );
    return { status: 'registered' };
  }

  /**
   * Unregister the push token of a specific device (e.g. on logout).
   */
  @UseGuards(HeaderAuthGuard)
  @Delete('push/unregister/:deviceId')
  async unregisterPushToken(
    @Param('deviceId') deviceIdRaw: string,
    @Headers('x-user-id') userIdRaw: string,
  ) {
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const deviceId = sanitizeQueryValue(deviceIdRaw, 'deviceId');

    await this.pushTokenRepo.delete({ userId, deviceId });
    this.logger.log(`[PUSH_UNREGISTER] user=${userId} device=${deviceId}`);
    return { status: 'unregistered' };
  }
}
