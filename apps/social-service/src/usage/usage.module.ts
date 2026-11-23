import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageActivity } from './usage-activity';
import { UsageController } from './usage.controller';
import { UsageFigureRow } from './usage-figure.entity';
import { UsageFold } from './usage-fold';

/**
 * The usage dashboard (docs/wiki/usage-dashboard.md). GLOBAL so that every service that counts an
 * activity receives {@link UsageActivity} without its module naming this one.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([UsageFigureRow])],
  controllers: [UsageController],
  providers: [UsageActivity, UsageFold],
  exports: [UsageActivity],
})
export class UsageModule {}
