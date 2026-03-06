import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { getModelToken } from '@nestjs/mongoose';
import { Message } from './message.schema';
import { MessageSentEvent, MessageReadEvent } from '@mines-app/shared-ts';

describe('AppController', () => {
  let appController: AppController;
  let mockMessageModel: any;
  let mockMessageInstance: any;

  beforeEach(async () => {
    mockMessageInstance = {
      save: jest.fn().mockResolvedValue(true),
    };

    mockMessageModel = jest.fn().mockReturnValue(mockMessageInstance);

    // Static methods
    mockMessageModel.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([]),
        }),
      }),
    });
    mockMessageModel.updateOne = jest
      .fn()
      .mockResolvedValue({ modifiedCount: 1 });

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: getModelToken(Message.name),
          useValue: mockMessageModel,
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return empty list of messages initially', async () => {
      expect(await appController.getMessages()).toEqual([]);
    });

    it('should handle chat message event', async () => {
      const event: MessageSentEvent = {
        id: 'uuid-123',
        senderId: 'user-1',
        username: 'Alice',
        content: 'Hello World',
        timestamp: new Date().toISOString(),
        conversationId: null,
      };

      await appController.handleChatMessage(event);

      expect(mockMessageModel).toHaveBeenCalledWith({
        uuid: event.id,
        content: event.content,
        username: event.username,
        senderId: event.senderId,
        createdAt: expect.any(Date),
        readBy: [],
      });
      expect(mockMessageInstance.save).toHaveBeenCalled();
    });

    it('should handle message read event', async () => {
      const event: MessageReadEvent = {
        messageId: 'uuid-123',
        userId: 'user-2',
        timestamp: new Date().toISOString(),
        conversationId: null,
      };

      await appController.handleMessageRead(event);

      expect(mockMessageModel.updateOne).toHaveBeenCalledWith(
        { uuid: event.messageId },
        { $addToSet: { readBy: event.userId } },
      );
    });
  });
});
