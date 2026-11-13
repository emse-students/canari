import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { StorageService } from './storage.service';
import { UploadSessionService } from './upload-session.service';
import { LiveSegmentsService } from './live-segments.service';
import { LiveSegmentStore } from './live-segment-store';

@Module({
  controllers: [MediaController],
  providers: [
    MediaService,
    StorageService,
    UploadSessionService,
    LiveSegmentStore,
    LiveSegmentsService,
  ],
})
export class MediaModule {}
