import { BadRequestException } from '@nestjs/common';
import { IsNull, Raw, type EntityManager } from 'typeorm';
import { associationArchivedSql } from '../associations/association-archived';

/**
 * A form's life: a DRAFT is built and seen by its managers only, a PUBLISHED form is answerable
 * (owner, 2026-11-08). Migration 145 stores it; every form written before it is `published`, and a
 * form never goes back to draft - an answer, a reminder or a link handed out cannot be taken back.
 */
export type FormStatus = 'draft' | 'published';

/** The status of a form nobody can answer yet. */
export const FORM_DRAFT: FormStatus = 'draft';

/** The status of an answerable form - the column default, so an older container writes it. */
export const FORM_PUBLISHED: FormStatus = 'published';

/**
 * The typed refusal of a write that would show a DRAFT form to people who cannot see it: a post
 * attaching it, an agenda event linking it. Worded by the client.
 */
export const FORM_IS_DRAFT = 'FORM_IS_DRAFT';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ONE `where` of every RESPONDENT read: the form exists, is not archived, is published, and its
 * association (when it has one) is not ARCHIVED. A draft, and a form of an archived association,
 * answer exactly what an absent form answers (404), so a respondent cannot learn that the id exists:
 * an archive ends the association's active life, its forms included, whoever holds their link
 * (owner's archive rule: it already took them out of every list and every reminder). Managers read
 * through `assertFormManager`, which ignores the status and the archive; a payment already issued
 * settles through the submission's own paths, which never read this.
 */
export function respondentFormWhere(id: string) {
  return {
    id,
    deletedAt: IsNull(),
    status: FORM_PUBLISHED,
    associationId: Raw((column) => `NOT ${associationArchivedSql(column)}`),
  };
}

/**
 * Refuses (400, `FORM_IS_DRAFT`) handing a draft form to a surface other people read. An unknown id
 * is NOT refused here: the callers' own rules answer it, as they did before drafts existed.
 */
export async function assertFormNotDraft(
  manager: EntityManager,
  formId: string | null | undefined,
  what: string
): Promise<void> {
  // Asked by callers that do not all validate their id: one that is not a uuid names no form row,
  // and asking PostgreSQL would be a 22P02 rather than an answer. (A post's DTOs refuse it first.)
  if (!formId || !UUID_RE.test(formId)) return;
  const rows: { status: FormStatus }[] = await manager.query(
    'SELECT status FROM forms WHERE id = $1',
    [formId]
  );
  if (rows[0]?.status !== FORM_DRAFT) return;
  throw new BadRequestException({
    code: FORM_IS_DRAFT,
    message: `A draft form cannot be attached to ${what}: publish it first.`,
  });
}
