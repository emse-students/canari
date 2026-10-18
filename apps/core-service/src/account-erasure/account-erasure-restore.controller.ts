import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { assertInternalSecret } from '../internal/internal-secret.util';
import { AccountErasureService } from './account-erasure.service';
import {
  MalformedErasureJournalError,
  parseErasureJournal,
  type ErasureJournalExport,
} from './erasure-policy';

/**
 * The two halves of the replay a backup restore owes (docs/wiki/account-erasure.md#a-restore-replays-the-erasures):
 * `infrastructure/backup/restore.sh` reads the journal here BEFORE it replaces the database, and
 * hands it back once the restored one is live. Both calls are made from inside the core-service
 * container by `restore-replay.ts`.
 *
 * NOT reachable through nginx: `/api/internal` has no location, so this is Docker-network only, and
 * gated on INTERNAL_SECRET on top of that.
 */
@Controller('internal/account-erasure')
export class AccountErasureRestoreController {
  private readonly logger = new Logger(AccountErasureRestoreController.name);

  constructor(private readonly erasure: AccountErasureService) {}

  /** The current journal, as {@link AccountErasureService.exportJournal} reads it. */
  @Get('journal')
  async journal(@Headers('x-internal-secret') secret?: string): Promise<ErasureJournalExport> {
    assertInternalSecret(secret);
    return this.erasure.exportJournal();
  }

  /** Erases again what the restore brought back ({@link AccountErasureService.replayAfterRestore}). */
  @Post('replay')
  @HttpCode(200)
  async replay(
    @Body() body: unknown,
    @Headers('x-internal-secret') secret?: string
  ): Promise<{ candidates: number; replayed: number; keptNewer: number }> {
    assertInternalSecret(secret);
    let journal: ErasureJournalExport;
    try {
      journal = parseErasureJournal(body);
    } catch (err) {
      if (!(err instanceof MalformedErasureJournalError)) throw err;
      this.logger.error(`[ERASURE] replay REFUSED: ${err.message}`);
      throw new BadRequestException({ code: err.code, message: err.message });
    }
    return this.erasure.replayAfterRestore(journal);
  }
}
