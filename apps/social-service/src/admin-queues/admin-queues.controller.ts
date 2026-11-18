import { Controller, Get, Headers, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { AdminQueuesService, type AdminQueueCounts } from './admin-queues.service';

/**
 * `GET /api/moderation/admin-queues`: the pending counts behind every admin badge (owner,
 * 2026-11-18). Under `/api/moderation` because that prefix already reaches this service.
 *
 * Open to every signed-in caller and answering only what the caller may act on
 * (`AdminQueuesService.pendingCounts`): a member with no tier gets `{ counts: {} }` rather than a
 * 403, so the client asks one question whatever the reader holds and never learns the size of a
 * queue it cannot open. `X-Global-Admin` is the header nginx sets from the token, as on every admin
 * route of this service.
 */
@Controller('moderation/admin-queues')
export class AdminQueuesController {
  constructor(private readonly queues: AdminQueuesService) {}

  @UseGuards(NginxAuthGuard)
  @Get()
  async counts(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ): Promise<{ counts: AdminQueueCounts }> {
    return { counts: await this.queues.pendingCounts(userId, ga === 'true') };
  }
}
