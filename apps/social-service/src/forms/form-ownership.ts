import { BadRequestException, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { AssociationPermissionFlag } from '../associations/entities/association-member.entity';
import { Form } from './entities/form.entity';

const logger = new Logger('FormOwnership');

/**
 * The typed refusal of a surface attaching a form that is not its own entity's: an agenda event or
 * an association's post naming another association's form (or a personal one), a personal post
 * naming a form its author does not manage. The message stays the events' historical one.
 */
export const FORM_NOT_OF_ENTITY = 'FORM_NOT_OF_ENTITY';

/** What an ownership decision reads of a form: who it belongs to, and whether it is published. */
export type FormOwnership = Pick<Form, 'id' | 'associationId' | 'ownerId' | 'status'>;

/** `mayAct` as `AssociationsService` answers it, injected so this module depends on no service. */
export type MayAct = (
  userId: string,
  associationId: string,
  flag: AssociationPermissionFlag,
  opts?: { isGlobalAdmin?: boolean }
) => Promise<boolean>;

/** Reads a form's ownership; 400 `Linked form not found` when the id names none (the events' answer). */
async function readFormOwnership(manager: EntityManager, formId: string): Promise<FormOwnership> {
  const form = await manager.getRepository(Form).findOne({
    where: { id: formId },
    select: { id: true, associationId: true, ownerId: true, status: true },
  });
  if (!form) {
    logger.debug(`[FORMS] attach refused: form ${formId.slice(0, 8)} does not exist`);
    throw new BadRequestException('Linked form not found');
  }
  return form;
}

/** The refusal of a form that is not the attaching entity's own, logged with what asked. */
function notOfEntity(formId: string, what: string): BadRequestException {
  logger.log(`[FORMS] ${what} refused: form ${formId.slice(0, 8)} is not its entity's own`);
  return new BadRequestException({
    code: FORM_NOT_OF_ENTITY,
    message: 'Form must belong to this association',
  });
}

/**
 * Refuses (400 `FORM_NOT_OF_ENTITY`) attaching `formId` to something `associationId` publishes - an
 * agenda event, an association's, institution's or list's post - unless the form belongs to that
 * same association. An entity presents its own forms: another association's form shown under its
 * name would be offered, answered and paid as if it were its own. Returns the form, so a caller
 * judges its other rules (a draft) on the same read.
 */
export async function assertFormOfAssociation(
  manager: EntityManager,
  formId: string,
  associationId: string,
  what: string
): Promise<FormOwnership> {
  const form = await readFormOwnership(manager, formId);
  if (form.associationId !== associationId) throw notOfEntity(formId, what);
  return form;
}

/**
 * Whether `viewer` manages `form`: a global admin; for an ASSOCIATION's form, MANAGE_FORMS on that
 * association (`mayAct`), whoever created it - owner, 2026-11-14: only the members holding "gérer
 * les formulaires" manage an association's forms; for a PERSONAL form, its owner. The ONE rule
 * `FormsService` gates its managers with and a personal post's attachment is judged by.
 */
export async function managesForm(
  form: Pick<Form, 'associationId' | 'ownerId'>,
  viewer: { userId: string; isGlobalAdmin: boolean } | undefined,
  mayAct: MayAct
): Promise<boolean> {
  if (!viewer?.userId) return false;
  if (viewer.isGlobalAdmin) return true;
  if (!form.associationId) return form.ownerId === viewer.userId;
  return mayAct(viewer.userId, form.associationId, AssociationPermissionFlag.MANAGE_FORMS, {
    isGlobalAdmin: viewer.isGlobalAdmin,
  });
}

/**
 * Refuses (400 `FORM_NOT_OF_ENTITY`) a PERSONAL post attaching `formId` unless its author manages
 * the form ({@link managesForm}) - exactly the forms the composer offers a person (`GET /forms`
 * lists those the reader owns or manages). Taken by default on 2026-11-14, to confirm with the
 * owner: a person may present a form of an association whose forms they manage, never anyone
 * else's.
 */
export async function assertAuthorManagesForm(
  manager: EntityManager,
  formId: string,
  author: { userId: string; isGlobalAdmin: boolean },
  mayAct: MayAct,
  what: string
): Promise<void> {
  const form = await readFormOwnership(manager, formId);
  if (!(await managesForm(form, author, mayAct))) throw notOfEntity(formId, what);
}
