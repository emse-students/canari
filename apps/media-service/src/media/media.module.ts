import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { StorageService } from './storage.service';

@Module({
  controllers: [MediaController],
  providers: [MediaService, StorageService],
})
export class MediaModule {}
