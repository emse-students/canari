import { Controller, Get } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Message } from './message.schema';
import { MessageSentEvent, MessageReadEvent, KAFKA_TOPICS } from '@mines-app/shared-ts';

@Controller()
export class AppController {
  constructor(@InjectModel(Message.name) private messageModel: Model<Message>) {}

  @Get('messages')
  async getMessages() {
    return this.messageModel.find().sort({ createdAt: -1 }).limit(10).exec();
  }

  @EventPattern(KAFKA_TOPICS.CHAT_MESSAGES)
  async handleChatMessage(@Payload() message: MessageSentEvent) {
    console.log('Received message from Kafka:', message);
    
    // Support both wrapped NestJS Kafka messages and raw payloads
    // @ts-ignore
    const eventData: MessageSentEvent = (message && message.value) ? message.value : message;

    const createdMessage = new this.messageModel({
      uuid: eventData.id,
      content: eventData.content,
      username: eventData.username,
      senderId: eventData.senderId,
      createdAt: new Date(eventData.timestamp),
      readBy: []
    });
    
    await createdMessage.save();
    console.log('Message saved to MongoDB');
  }

  @EventPattern(KAFKA_TOPICS.MESSAGE_READ)
  async handleMessageRead(@Payload() message: MessageReadEvent) {
    // @ts-ignore
    const eventData: MessageReadEvent = (message && message.value) ? message.value : message;
    console.log(`Message ${eventData.messageId} read by ${eventData.userId} at ${eventData.timestamp}`);
    
    await this.messageModel.updateOne(
        { uuid: eventData.messageId },
        { $addToSet: { readBy: eventData.userId } }
    );
  }
}

