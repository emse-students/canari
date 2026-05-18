import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserTag } from './entities/user-tag.entity';
import { UserTagService } from './user-tag.service';

/** Provides UserTagService for managing association cotisation tags. */
@Module({
  imports: [TypeOrmModule.forFeature([UserTag])],
  providers: [UserTagService],
  exports: [UserTagService],
})
export class UserTagModule {}
