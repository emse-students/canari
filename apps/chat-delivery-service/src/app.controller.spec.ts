import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { getModelToken } from '@nestjs/mongoose';
import { QueuedMessage } from './queued-message.schema';
import { KeyPackage } from './key-package.schema';
import { WelcomeMessage } from './welcome-message.schema';
import { UserState } from './user-state.schema';
import { GroupMember } from './group-member.schema';
import { Group } from './group.schema';

describe('AppController', () => {
  let appController: AppController;
  let mockQueuedMessageModel: any;
  let mockKeyPackageModel: any;
  let mockWelcomeMessageModel: any;
  let mockUserStateModel: any;

  beforeEach(async () => {
    mockQueuedMessageModel = {
      find: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn(),
      bulkWrite: jest.fn().mockResolvedValue({ insertedCount: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
      insertMany: jest.fn().mockResolvedValue([]),
    };

    mockKeyPackageModel = {
      updateOne: jest.fn().mockReturnThis(),
      find: jest.fn().mockReturnThis(),
      findOne: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      exec: jest.fn(),
    };

    mockWelcomeMessageModel = {};

    mockUserStateModel = {
      updateOne: jest.fn().mockReturnThis(),
      findOne: jest.fn().mockReturnThis(),
      exec: jest.fn(),
    };

    const mockGroupMemberModel = {
      find: jest.fn().mockReturnThis(),
      updateOne: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };

    const mockGroupModel = {
      findOne: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(null),
    };

    const mockRedis = {
      exists: jest.fn().mockResolvedValue(0),
      get: jest.fn().mockResolvedValue(null),
      publish: jest.fn().mockResolvedValue(1),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: getModelToken(QueuedMessage.name),
          useValue: mockQueuedMessageModel,
        },
        {
          provide: getModelToken(KeyPackage.name),
          useValue: mockKeyPackageModel,
        },
        {
          provide: getModelToken(WelcomeMessage.name),
          useValue: mockWelcomeMessageModel,
        },
        {
          provide: getModelToken(UserState.name),
          useValue: mockUserStateModel,
        },
        {
          provide: getModelToken(GroupMember.name),
          useValue: mockGroupMemberModel,
        },
        {
          provide: getModelToken(Group.name),
          useValue: mockGroupModel,
        },
        {
          provide: 'REDIS_CLIENT',
          useValue: mockRedis,
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('Device Registration', () => {
    it('should register a device', async () => {
      const dto = {
        userId: 'bob',
        deviceId: 'dev1',
        keyPackage: 'kp_bytes',
      };
      await appController.registerDevice(dto);
      expect(mockKeyPackageModel.updateOne).toHaveBeenCalledWith(
        { userId: 'bob', deviceId: 'dev1' },
        {
          $set: { keyPackage: 'kp_bytes', createdAt: expect.any(Date) },
        },
        { upsert: true },
      );
    });

    it('should list user devices', async () => {
      const devices = [{ deviceId: 'd1' }, { deviceId: 'd2' }];
      mockKeyPackageModel.exec.mockResolvedValueOnce(devices);

      const result = await appController.getUserDevices('bob');
      expect(mockKeyPackageModel.find).toHaveBeenCalledWith({
        userId: 'bob',
      });
      expect(mockKeyPackageModel.sort).toHaveBeenCalledWith({
        createdAt: -1,
      });
      expect(result).toEqual(devices);
    });
  });

  describe('Messaging (Delivery)', () => {
    it('should send (queue) messages when offline', async () => {
      mockQueuedMessageModel.exec.mockResolvedValueOnce([]);
      const dto = {
        senderId: 'alice',
        recipients: [{ userId: 'bob', deviceId: 'dev1' }],
        content: 'encrypted_content',
        groupId: 'group1',
      };

      // Mock offline
      (appController as any).redis.exists.mockResolvedValue(0);

      await appController.sendMessage(dto);

      expect(mockQueuedMessageModel.bulkWrite).toHaveBeenCalledTimes(1);
      const callArg = mockQueuedMessageModel.bulkWrite.mock.calls[0][0];
      expect(callArg).toHaveLength(1);
      expect(callArg[0].insertOne.document).toEqual(
        expect.objectContaining({
          recipientId: 'bob',
          deviceId: 'dev1',
          senderId: 'alice',
          content: 'encrypted_content',
        }),
      );
    });

    it('should push directly when online', async () => {
      const dto = {
        senderId: 'alice',
        recipients: [{ userId: 'charlie', deviceId: 'dev_online' }],
        content: 'secret',
        groupId: 'g1',
      };

      // Mock online
      (appController as any).redis.exists.mockResolvedValue(1);

      await appController.sendMessage(dto);

      // Should Publish
      expect((appController as any).redis.publish).toHaveBeenCalledWith(
        'chat:messages',
        JSON.stringify({
          recipientId: 'charlie',
          deviceId: 'dev_online',
          senderId: 'alice',
          groupId: 'g1',
          content: 'secret',
        }),
      );

      // Should NOT Queue
      expect(mockQueuedMessageModel.bulkWrite).not.toHaveBeenCalled();
    });

    it('should fetch messages for a device', async () => {
      const messages = [
        { _id: 'msg1', content: 'hello' },
        { _id: 'msg2', content: 'world' },
      ];
      mockQueuedMessageModel.exec.mockResolvedValueOnce(messages);

      const result = await appController.fetchMessages('bob', 'dev1');

      expect(mockQueuedMessageModel.find).toHaveBeenCalledWith({
        recipientId: 'bob',
        deviceId: 'dev1',
      });
      expect(mockQueuedMessageModel.sort).toHaveBeenCalledWith({
        createdAt: 1,
      });
      expect(result).toEqual(messages);
    });

    it('should return empty list if no messages', async () => {
      mockQueuedMessageModel.exec.mockResolvedValueOnce([]);
      const result = await appController.fetchMessages('charlie', 'devX');
      expect(result).toEqual([]);
      expect(mockQueuedMessageModel.deleteMany).not.toHaveBeenCalled();
    });
  });
});
