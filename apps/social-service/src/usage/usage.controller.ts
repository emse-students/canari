import { Controller, Get, Logger, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { RedisService } from '../common/redis';
import { UsageFold } from './usage-fold';
import { readUsage, type UsageView } from './usage-read';

/**
 * `GET /api/admin/usage`: the usage dashboard, for the PLATFORM ADMINS ONLY (owner, 2026-11-19) -
 * aggregated figures, never a person (docs/wiki/usage-dashboard.md). nginx routes this one path to
 * this service; the rest of `/api/admin` stays on the gateway.
 *
 * It folds first, so the page never shows a figure older than its request. A Redis or a database
 * that cannot be read is a 503, never an empty dashboard: zero would be a claim.
 */
@Controller('admin/usage')
export class UsageController {
  private readonly logger = new Logger(UsageController.name);

  constructor(
    private readonly fold: UsageFold,
    @InjectDataSource() private readonly ds: DataSource,
    private readonly redis: RedisService
  ) {}

  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Get()
  async usage(): Promise<UsageView> {
    const now = new Date();
    this.logger.debug('[USAGE] dashboard read');
    try {
      await this.fold.foldOnce(now);
      return await readUsage(this.ds, this.redis, now);
    } catch (e) {
      this.logger.error(`[USAGE] the dashboard could not be read - answering 503: ${String(e)}`);
      throw new ServiceUnavailableException({ error: 'usage_unavailable' });
    }
  }
}
