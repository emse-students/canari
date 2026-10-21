import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';

const logger = new Logger('retireForms');

/** Which forms to retire: one form by id, or every form of an association. */
export type RetireTarget = { formId: string } | { associationId: string };

/**
 * Removes forms the way a form is allowed to go away: a form that holds submissions is ARCHIVED
 * (`deletedAt` set), one with none is deleted outright.
 *
 * WHY: `submissions.formId` carries a RESTRICT foreign key (migration 081), because a submission is
 * the payer's record and a cascade would destroy paid rows; before the key, deleting a form left
 * its submissions pointing at nothing (29 orphans on prod and dev). An archived form leaves every
 * list and every respondent flow but stays loadable by its staff, so its submissions stay readable.
 *
 * Takes the caller's `manager` so an association's delete keeps its ONE transaction. A submission
 * written between the two statements makes the DELETE fail on the key - loudly, never an orphan.
 */
export async function retireForms(
  manager: EntityManager,
  target: RetireTarget
): Promise<{ archived: number; deleted: number }> {
  const [column, value] =
    'formId' in target
      ? (['id', target.formId] as const)
      : (['associationId', target.associationId] as const);
  // `getQuery()` returns a bare `SELECT ...`: the parentheses `EXISTS` needs are written here.
  // Without them every call was a syntax error, unseen by a spec whose mock returned them.
  const hasSubmission = () =>
    `(${manager
      .createQueryBuilder()
      .select('1')
      .from(Submission, 's')
      .where('"s"."formId" = "forms"."id"')
      .getQuery()})`;

  const archivedResult = await manager
    .createQueryBuilder()
    .update(Form)
    .set({ deletedAt: () => 'now()' })
    .where(`"${column}" = :value`, { value })
    .andWhere('"deletedAt" IS NULL')
    .andWhere(`EXISTS ${hasSubmission()}`)
    .execute();

  const deletedResult = await manager
    .createQueryBuilder()
    .delete()
    .from(Form)
    .where(`"${column}" = :value`, { value })
    .andWhere(`NOT EXISTS ${hasSubmission()}`)
    .execute();

  const archived = archivedResult.affected ?? 0;
  const deleted = deletedResult.affected ?? 0;
  logger.log(
    `[FORMS] retire ${column}=${String(value).slice(0, 8)}: ${archived} archived (has submissions), ${deleted} deleted`
  );
  return { archived, deleted };
}
