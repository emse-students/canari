import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostsModule } from '../posts/posts.module';
import { ProfileBirthday } from './entities/profile-birthday.entity';
import { BirthdayChange } from './entities/birthday-change.entity';
import { BirthdaysController } from './birthdays.controller';
import { BirthdaysService } from './birthdays.service';
import { BirthdayNotifier } from './birthday-notifier.scheduler';

/**
 * Birthdays on profiles (migration 148, docs/wiki/birthdays.md): the member's date and who may read
 * it, today's celebrants for the avatar ring, and the morning notice to their followers.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProfileBirthday, BirthdayChange]), PostsModule],
  controllers: [BirthdaysController],
  providers: [BirthdaysService, BirthdayNotifier],
})
export class BirthdaysModule {}
