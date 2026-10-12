import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { StorageService } from './storage.service';
import { UploadSessionService } from './upload-session.service';

@Module({
  controllers: [MediaController],
  providers: [MediaService, StorageService, UploadSessionService],
})
export class MediaModule {}
