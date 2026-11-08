import { BadRequestException } from '@nestjs/common';
import { IsNull, type EntityManager } from 'typeorm';

/**
 * A form's life: a DRAFT is built and seen by its managers only, a PUBLISHED form is answerable
 * (owner, 2026-11-08). Migration 142 stores it; every form written before it is `published`, and a
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
 * The ONE `where` of every RESPONDENT read: the form exists, is not archived, and is published. A
 * draft answers exactly what an absent form answers (404), so a respondent cannot learn that a draft
 * id exists. Managers read through `assertFormManager`, which ignores the status.
 */
export function respondentFormWhere(id: string) {
  return { id, deletedAt: IsNull(), status: FORM_PUBLISHED };
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
  // A post's `attachedFormId` is a bare string: one that is not a uuid names no form row, and
  // asking PostgreSQL would be a 22P02 rather than an answer.
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
