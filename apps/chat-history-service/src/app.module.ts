import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { Message, MessageSchema } from './message.schema';

@Module({
  imports: [
    MongooseModule.forRoot('mongodb://localhost:27017/chat_db'),
    MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }]),
  ],
  controllers: [AppController],
})
export class AppModule {}
