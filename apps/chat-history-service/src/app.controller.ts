import { Controller, Get, Post, Body, Param, Put, Delete, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { QueuedMessage } from './queued-message.schema';
import { KeyPackage } from './key-package.schema';
import { WelcomeMessage } from './welcome-message.schema';
import { GroupMember } from './group-member.schema';
import { Group } from './group.schema';
import { UserState } from './user-state.schema';
import Redis from 'ioredis';
import * as crypto from 'crypto';

// Server-Side Encryption Key (In production, use strict ENV vars or KMS)
const ENCRYPTION_KEY = Buffer.from('b340600b2f803ee7fab5e4bd8a69c142ef06c682002c85e9f230ab8dd1df0b7e', 'hex');
const IV_LENGTH = 16;

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
    @InjectModel(QueuedMessage.name) private queuedMessageModel: Model<QueuedMessage>,
    @InjectModel(KeyPackage.name) private keyPackageModel: Model<KeyPackage>,
    @InjectModel(WelcomeMessage.name) private welcomeMessageModel: Model<WelcomeMessage>,
    @InjectModel(GroupMember.name) private groupMemberModel: Model<GroupMember>,
    @InjectModel(Group.name) private groupModel: Model<Group>,
    @InjectModel(UserState.name) private userStateModel: Model<UserState>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis
  ) {}

  @Post('mls/state')
  async uploadUserState(@Body() body: { userId: string, encryptedState: string }) {
    // Double Encryption: Encrypt the already client-encrypted blob with Server Key
    const serverEncrypted = encryptServerSide(body.encryptedState);
    
    await this.userStateModel.updateOne(
        { userId: body.userId },
        { $set: { encryptedState: serverEncrypted, updatedAt: new Date() } },
        { upsert: true }
    );
    return { status: 'success' };
  }

  @Get('mls/state/:userId')
  async getUserState(@Param('userId') userId: string) {
    const doc = await this.userStateModel.findOne({ userId }).exec();
    if (!doc) return null;
    
    // Decrypt before sending back to client
    try {
        const originalBlob = decryptServerSide(doc.encryptedState);
        return { ...doc.toObject(), encryptedState: originalBlob };
    } catch (e) {
        console.error("Decryption failed for user", userId, e);
        return null;
    }
  }


  @Post('mls-api/groups')
  async createGroup(@Body() body: { name: string, createdBy: string }) {
      const groupId = uuidv4();
      await this.groupModel.create({
          groupId,
          name: body.name,
          createdBy: body.createdBy,
          createdAt: new Date()
      });
      return { groupId, name: body.name };
  }

  @Get('mls-api/groups/:groupId')
  async getGroup(@Param('groupId') groupId: string) {
      return this.groupModel.findOne({ groupId }).exec();
  }

  @Post('mls-api/groups/:groupId/members')
  async addGroupMember(@Param('groupId') groupId: string, @Body() body: { userId: string, deviceId: string }) {
      await this.groupMemberModel.updateOne(
          { groupId, userId: body.userId, deviceId: body.deviceId },
          { $set: { joinedAt: new Date() } },
          { upsert: true }
      );
      // Sync to Redis for Gateway access
      await this.redis.sadd(`group:members:${groupId}`, `${body.userId}:${body.deviceId}`);
      return { status: 'added' };
  }

  @Get('mls-api/groups/:groupId/members')
  async getGroupMembers(@Param('groupId') groupId: string) {
      return this.groupMemberModel.find({ groupId }).exec();
  }

  @Post('mls-api/register-device')
  async registerDevice(@Body() body: { userId: string, deviceId: string, keyPackage: string }) {
    await this.keyPackageModel.updateOne(
        { userId: body.userId, deviceId: body.deviceId },
        { 
            $set: { 
                keyPackage: body.keyPackage,
                createdAt: new Date() 
            }
        },
        { upsert: true }
    );
    return { status: 'registered' };
  }

  @Get('mls-api/devices/:userId')
  async getUserDevices(@Param('userId') userId: string) {
      // Returns all active devices for a user
      return this.keyPackageModel.find({ userId }).sort({ createdAt: -1 }).exec();
  }

  @Post('mls-api/send')
  async sendMessage(@Body() body: { 
      senderId: string,
      senderDeviceId?: string, 
      recipients?: { userId: string, deviceId?: string }[], 
      content: string, 
      groupId: string,
      type?: string
  }) {
      const { senderId, senderDeviceId, content, groupId, type } = body;
      
      let targetList: { userId: string, deviceId: string }[] = [];

      // If recipients not provided, fetch from Group Members in DB
      if (!body.recipients || body.recipients.length === 0) {
          const members = await this.groupMemberModel.find({ groupId }).lean().exec();
          targetList = members
            .filter(m => {
                if (senderDeviceId) return !(m.userId === senderId && m.deviceId === senderDeviceId);
                return m.userId !== senderId;
            }) 
            .map(m => ({ userId: m.userId, deviceId: m.deviceId }));
      } else {
          // Process provided recipients (handle fan-out)
          for (const r of body.recipients) {
              if (r.deviceId) {
                  targetList.push({ userId: r.userId, deviceId: r.deviceId });
              } else {
                  // Fan-out: Fetch all devices for this user from Registry
                  const devices = await this.keyPackageModel.find({ userId: r.userId }).lean().exec();
                  if (devices.length > 0) {
                      for (const d of devices) {
                          // Don't send back to sender's own device if matched
                          if (r.userId === senderId && d.deviceId === senderDeviceId) continue;
                          targetList.push({ userId: r.userId, deviceId: d.deviceId });
                      }
                  } else {
                      console.log(`No devices found for user ${r.userId} during fan-out.`);
                  }
              }
          }
      }
      
      const ops = [];
      let sentCount = 0;

      for (const r of targetList) {
          // Check if specific device is connected to Gateway
          // Note: Gateway uses "user:online:userId:deviceId"
          const isOnline = await this.redis.exists(`user:online:${r.userId}:${r.deviceId}`);
          
          if (isOnline) {
              // Push directly to Gateway via Redis PubSub
              await this.redis.publish('chat:messages', JSON.stringify({
                  recipientId: r.userId,
                  deviceId: r.deviceId,
                  senderId,
                  groupId,
                  content,
                  type
              }));
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
                          groupId,
                          content,
                          type,
                          createdAt: new Date()
                      }
                  }
              });
          }
      }

      if (ops.length > 0) {
          await this.queuedMessageModel.bulkWrite(ops);
      }
      
      return { status: 'processed', queued: ops.length, sent: sentCount };
  }

  @Get('history/:groupId')
  async getHistory(@Param('groupId') groupId: string) {
      const streamKey = `history:${groupId}`;
      try {
          // ioredis xrange returns [id, [key, value, key, value...]]
          const entries = await this.redis.xrange(streamKey, '-', '+');
          return entries.map(([id, fields]) => {
              const msg: any = { id };
              for (let i = 0; i < fields.length; i += 2) {
                  msg[fields[i]] = fields[i+1];
              }
              return msg;
          });
      } catch (e) {
          console.error("History fetch error:", e);
          return [];
      }
  }

  @Get('mls-api/messages/:userId/:deviceId')
  async fetchMessages(@Param('userId') userId: string, @Param('deviceId') deviceId: string) {
      const messages = await this.queuedMessageModel.find({ 
          recipientId: userId, 
          deviceId: deviceId 
      }).sort({ createdAt: 1 }).lean().exec();

      if (messages.length > 0) {
          const ids = messages.map(m => m._id);
          await this.queuedMessageModel.deleteMany({ _id: { $in: ids } });
      }

      return messages;
  }
}
