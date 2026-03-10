import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
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

import { v4 as uuidv4 } from 'uuid';

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
      createdAt: new Date(),
    });

    // Real-time push via Gateway when the target device is currently online.
    const redisKey = `user:online:${deviceInfo.userId}:${targetDeviceId}`;
    const isOnline = await this.redis.exists(redisKey);
    console.log(`[DELIVERY] Checking presence for ${redisKey} -> ${isOnline}`);
    if (isOnline) {
      const ciphertext = Buffer.from(body.welcomePayload, 'base64');
      const envelope = await encodeInboundMsgEnvelope(
        deviceInfo.userId,
        targetDeviceId,
        {
          ciphertext,
          senderId: senderUserId,
          senderDeviceId: '',
          groupId: safeGroupId,
          isWelcome: true,
        },
      );
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
          const envelope = await encodeInboundMsgEnvelope(
            r.userId,
            r.deviceId,
            {
              ciphertext,
              senderId,
              senderDeviceId: senderDeviceId ?? '',
              groupId,
              isWelcome,
            },
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
