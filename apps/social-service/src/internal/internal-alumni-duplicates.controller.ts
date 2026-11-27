import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { assertInternalSecret } from './internal-secret.util';
import { AdminQueuesService } from '../admin-queues/admin-queues.service';

/** A MiConnect uuid, the identity of an Alumni duplicate. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Alumni duplicates queue's two doors for core-service (owner, 2026-11-26: every admin queue runs
 * through the ONE mechanism of `AdminQueuesService`). Internal-only like the profile corrections':
 * core-service owns the duplicates (`alumni_duplicate_flags`, `alumni_merges`) and calls here.
 */
@Controller('internal/notifications')
export class InternalAlumniDuplicatesController {
  private readonly logger = new Logger(InternalAlumniDuplicatesController.name);

  constructor(private readonly adminQueues: AdminQueuesService) {}

  /**
   * An Alumni duplicate was FLAGGED, for the first time (`AlumniDuplicateQueue.reconcile`): every
   * global admin gets the bell row and the push, which clears for all of them once one marks it for a
   * merge. Answers how many admins have the bell row; a failure to write the rows is a 500 the
   * caller logs at ERROR - the flag itself is saved and counted.
   */
  @Post('alumni-duplicate-flagged')
  @HttpCode(200)
  async flagged(
    @Headers('x-internal-secret') secret: string | undefined,
    @Body() body: { duplicateUuid?: string }
  ): Promise<{ told: number }> {
    assertInternalSecret(secret);
    if (!body?.duplicateUuid || !UUID_RE.test(body.duplicateUuid)) {
      this.logger.warn('[ALUMNI_QUEUE] flagged notice refused: malformed body');
      throw new BadRequestException('duplicateUuid must be a uuid');
    }
    return { told: await this.adminQueues.announceAlumniDuplicate(body.duplicateUuid) };
  }

  /**
   * An item left the queue or came back to it (a duplicate marked for a merge, a mark withdrawn, one
   * found gone): the admins' badges recount. No notice, no push: the push is once per duplicate, and
   * the bell row follows the item's own state (`BELL_ROW_GATE`). Never fails (the signal logs).
   */
  @Post('alumni-duplicates-changed')
  @HttpCode(200)
  async changed(@Headers('x-internal-secret') secret: string | undefined): Promise<{ ok: true }> {
    assertInternalSecret(secret);
    await this.adminQueues.queueChanged({ queue: 'alumni-duplicates' });
    return { ok: true };
  }
}
