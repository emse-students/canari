import { Module } from '@nestjs/common';
import { SkyEntourageController } from './sky.controller';

/** Read-only proxy to the Sky app for parrainage entourage on user profiles. */
@Module({
  controllers: [SkyEntourageController],
})
export class SkyModule {}
