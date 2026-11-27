import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ALUMNI_MERGE_SUBJECT_RE } from '../auth/handoff/handoff-token';
import { AlumniMergeService } from './alumni-merge.service';

/** The header MiConnect's webhook transport carries the shared secret in (85-alumni-merge-push.yaml). */
export const ALUMNI_MERGE_HOOK_SECRET_HEADER = 'x-miconnect-alumni-merge-secret';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Absent, empty, or a well-formed subject. */
const subjectOk = (v: unknown): boolean =>
  v === undefined || v === '' || (typeof v === 'string' && ALUMNI_MERGE_SUBJECT_RE.test(v));

const logger = new Logger('AlumniMergeHook');

/**
 * Throws 401 unless `received` is `MICONNECT_ALUMNI_MERGE_WEBHOOK_SECRET`, compared in constant time.
 * An unset secret matches nothing (fail closed) and is said at error: it is a deployment fault, and
 * every merge then waits for the admin page's reconciler.
 */
export function assertAlumniMergeHookSecret(received: string | undefined): void {
  const expected = Buffer.from(process.env.MICONNECT_ALUMNI_MERGE_WEBHOOK_SECRET?.trim() ?? '');
  const given = Buffer.from(received ?? '');
  if (expected.length === 0) {
    logger.error(
      '[ALUMNI_MERGE] push refused: MICONNECT_ALUMNI_MERGE_WEBHOOK_SECRET is unset on this estate - ' +
        'a deployment fault (infrastructure/MIGRATION.md); the page reading completes the merge'
    );
    throw new UnauthorizedException();
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    logger.error('[ALUMNI_MERGE] push refused: the shared secret does not match, nothing read');
    throw new UnauthorizedException();
  }
}

/**
 * MiConnect's PUSH of a completed Alumni merge (D54): `POST /api/hooks/miconnect/alumni-merge`, no
 * session, routed by the edge to core-service with every trust header stripped
 * (infrastructure/local/Dockerfile.frontend). The secret is checked BEFORE the body is read; the body
 * is a hint, and {@link AlumniMergeService.completeFromPush} re-reads MiConnect before it acts.
 */
@Controller('hooks/miconnect')
export class AlumniMergeHookController {
  constructor(private readonly alumniMerge: AlumniMergeService) {}

  /**
   * `{ duplicateUuid, targetUuid, mergeId, duplicateSubject, targetSubject }` -> `{ completed: true }`
   * or `{ already: true }`. The subjects are optional (a policy older than this body sends none).
   */
  @Post('alumni-merge')
  @HttpCode(200)
  push(
    @Headers(ALUMNI_MERGE_HOOK_SECRET_HEADER) secret: string | undefined,
    @Body()
    body:
      | {
          duplicateUuid?: unknown;
          targetUuid?: unknown;
          mergeId?: unknown;
          duplicateSubject?: unknown;
          targetSubject?: unknown;
        }
      | undefined
  ) {
    assertAlumniMergeHookSecret(secret);
    const { duplicateUuid, targetUuid, mergeId, duplicateSubject, targetSubject } = body ?? {};
    if (
      typeof duplicateUuid !== 'string' ||
      !UUID_RE.test(duplicateUuid) ||
      typeof targetUuid !== 'string' ||
      !UUID_RE.test(targetUuid) ||
      (mergeId !== undefined &&
        mergeId !== '' &&
        (typeof mergeId !== 'string' || !UUID_RE.test(mergeId))) ||
      !subjectOk(duplicateSubject) ||
      !subjectOk(targetSubject)
    ) {
      logger.error('[ALUMNI_MERGE] push refused: a malformed body, nothing read');
      throw new BadRequestException(
        'duplicateUuid and targetUuid must be uuids, mergeId a uuid or empty, the subjects well-formed'
      );
    }
    return this.alumniMerge.completeFromPush(
      duplicateUuid,
      targetUuid,
      typeof mergeId === 'string' ? mergeId : '',
      {
        duplicateSubject: (duplicateSubject as string | undefined) || undefined,
        targetSubject: (targetSubject as string | undefined) || undefined,
      }
    );
  }
}
