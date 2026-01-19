import { Controller, Get } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Message } from './message.schema';
import { MessageSentEvent } from '@mines-app/shared-ts';

@Controller()
export class AppController {
  constructor(@InjectModel(Message.name) private messageModel: Model<Message>) {}

  @Get('messages')
  async getMessages() {
    return this.messageModel.find().sort({ createdAt: -1 }).limit(10).exec();
  }

  @EventPattern('chat_messages')
  async handleChatMessage(@Payload() message: MessageSentEvent) {
    console.log('Received message from Kafka:', message);
    
    // Support both wrapped NestJS Kafka messages and raw payloads
    // @ts-ignore
    const eventData: MessageSentEvent = (message && message.value) ? message.value : message;

    const createdMessage = new this.messageModel({
      content: eventData.content,
      username: eventData.username,
      senderId: eventData.senderId,
      createdAt: new Date(eventData.timestamp)
    });
    
    await createdMessage.save();
    console.log('Message saved to MongoDB');
  }
}

