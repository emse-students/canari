import {
  Controller,
  Get,
  Post,
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
import { UserState } from './user-state.schema';
import Redis from 'ioredis';
import * as crypto from 'crypto';

// Server-Side Encryption Key (In production, use strict ENV vars or KMS)
const ENCRYPTION_KEY = Buffer.from(
  'b340600b2f803ee7fab5e4bd8a69c142ef06c682002c85e9f230ab8dd1df0b7e',
  'hex',
);
const IV_LENGTH = 16;
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

function encryptServerSide(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  // Store as IV:AuthTag:Encrypted
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptServerSide(text: string): string {
  const parts = text.split(':');
  if (parts.length < 3) return text; // Fallback for unencrypted legacy data

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];

  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
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
    @InjectModel(UserState.name) private userStateModel: Model<UserState>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  @Post('mls/state')
  async uploadUserState(
    @Body() body: { userId: string; encryptedState: string },
  ) {
    // Double Encryption: Encrypt the already client-encrypted blob with Server Key
    const serverEncrypted = encryptServerSide(body.encryptedState);

    await this.userStateModel.updateOne(
      { userId: body.userId },
      { $set: { encryptedState: serverEncrypted, updatedAt: new Date() } },
      { upsert: true },
    );
    return { status: 'success' };
  }

  @Get('mls/state/:userId')
  async getUserState(@Param('userId') userId: string) {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    const doc = await this.userStateModel
      .findOne({ userId: safeUserId })
      .exec();
    if (!doc) return null;

    // Decrypt before sending back to client
    try {
      const originalBlob = decryptServerSide(doc.encryptedState);
      return { ...doc.toObject(), encryptedState: originalBlob };
    } catch {
      console.error('Decryption failed for user state');
      return null;
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
    await this.groupMemberModel.updateOne(
      { groupId, userId: body.userId, deviceId: body.deviceId },
      { $set: { joinedAt: new Date() } },
      { upsert: true },
    );
    // Sync to Redis for Gateway access
    await this.redis.sadd(
      `group:members:${groupId}`,
      `${body.userId}:${body.deviceId}`,
    );
    return { status: 'added' };
  }

  @Get('mls-api/groups/:groupId/members')
  async getGroupMembers(@Param('groupId') groupId: string) {
    return this.groupMemberModel.find({ groupId }).exec();
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
    const isOnline = await this.redis.exists(
      `user:online:${deviceInfo.userId}:${targetDeviceId}`,
    );
    if (isOnline) {
      await this.redis.publish(
        'chat:messages',
        JSON.stringify({
          recipientId: deviceInfo.userId,
          deviceId: targetDeviceId,
          senderId: senderUserId,
          groupId: safeGroupId,
          content: body.welcomePayload,
          type: 'mlsWelcome',
        }),
      );
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
      senderId: string;
      senderDeviceId?: string;
      recipients?: { userId: string; deviceId?: string }[];
      content: string;
      groupId: string;
      type?: string;
    },
  ) {
    const senderId = sanitizeQueryValue(body.senderId, 'senderId');
    const senderDeviceId = sanitizeOptionalQueryValue(
      body.senderDeviceId,
      'senderDeviceId',
    );
    const groupId = sanitizeQueryValue(body.groupId, 'groupId');
    const { content, type } = body;

    let targetList: { userId: string; deviceId: string }[] = [];

    // If recipients not provided, fetch from Group Members in DB
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
      // Process provided recipients (NO FAN_OUT - Strict Device Targeting)
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

    const ops: AnyBulkWriteOperation<QueuedMessage>[] = [];
    let sentCount = 0;

    for (const r of targetList) {
      // Check if specific device is connected to Gateway
      // Note: Gateway uses "user:online:userId:deviceId"
      const isOnline = await this.redis.exists(
        `user:online:${r.userId}:${r.deviceId}`,
      );

      if (isOnline) {
        // Push directly to Gateway via Redis PubSub
        await this.redis.publish(
          'chat:messages',
          JSON.stringify({
            recipientId: r.userId,
            deviceId: r.deviceId,
            senderId,
            senderDeviceId,
            groupId,
            content,
            type,
          }),
        );
        sentCount++;
      } else {
        // Queue for polling (Store)
        // Only store if we haven't already queued for this exact target?
        // MongoDB bulkWrite is just operations.
        ops.push({
          insertOne: {
            document: {
              recipientId: r.userId,
              deviceId: r.deviceId,
              senderId,
              senderDeviceId,
              groupId,
              content,
              type,
              createdAt: new Date(),
            },
          },
        });
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
