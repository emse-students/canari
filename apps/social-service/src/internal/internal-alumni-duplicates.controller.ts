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

/** The most duplicates one reading may announce at once. */
const MAX_FOUND = 200;

/** A batch's id: the digest core-service names it by (a SHA-256 in hex). */
const BATCH_ID_RE = /^[0-9a-f]{64}$/;

/**
 * The Alumni duplicates queue's doors for core-service (owner, 2026-11-26: every admin queue runs
 * through the ONE mechanism of `AdminQueuesService`). Internal-only like the profile corrections':
 * core-service owns the duplicates (`alumni_duplicate_flags`, `alumni_merges`) and calls here.
 */
@Controller('internal/notifications')
export class InternalAlumniDuplicatesController {
  private readonly logger = new Logger(InternalAlumniDuplicatesController.name);

  constructor(private readonly adminQueues: AdminQueuesService) {}

  /**
   * Alumni duplicates were found (`AlumniDuplicateQueue`: a sign-in's one, a reading's backlog, a
   * retry of a notice that was not confirmed): ONE push and ONE bell row to every global admin for the
   * whole batch (`AdminQueuesService.announceAlumniDuplicates`), so a backlog found at once is
   * never a burst on the admins' phones nor a flood in their bells. IDEMPOTENT on `batchId`: a batch
   * already told answers `replayed` and rings nothing. A failure to write the row is a
   * 500 the caller logs at ERROR and tries again - its flags are saved and counted.
   */
  @Post('alumni-duplicates-found')
  @HttpCode(200)
  async found(
    @Headers('x-internal-secret') secret: string | undefined,
    @Body() body: { duplicateUuids?: unknown; batchId?: unknown }
  ): Promise<{ told: number; replayed: boolean }> {
    assertInternalSecret(secret);
    const list = body?.duplicateUuids;
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.length > MAX_FOUND ||
      !list.every((u) => typeof u === 'string' && UUID_RE.test(u)) ||
      typeof body.batchId !== 'string' ||
      !BATCH_ID_RE.test(body.batchId)
    ) {
      this.logger.warn('[ALUMNI_QUEUE] found notice refused: malformed body');
      throw new BadRequestException(
        `duplicateUuids must be 1 to ${MAX_FOUND} uuids and batchId a SHA-256 in hex`
      );
    }
    return this.adminQueues.announceAlumniDuplicates(list as string[], body.batchId as string);
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
