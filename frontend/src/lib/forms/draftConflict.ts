// THE CLASS ALONE, with no Paraglide or API import: the autosave reads it by `instanceof`, and its
// tests must not pull the whole forms API to do so.
import { ApiRefusalError } from '$lib/utils/apiRefusalError';

/** The 409 of a revision write built on a revision another writer moved. */
export const FORM_DRAFT_CONFLICT = 'FORM_DRAFT_CONFLICT';

/**
 * A revision save refused `409 FORM_DRAFT_CONFLICT`, typed at the throw with what the refusal
 * carries: the revision the server holds and the client id of the save that wrote it. When that id
 * is the caller's own unanswered save, the save DID land - its answer was lost - and the caller
 * adopts the revision instead of reporting a conflict (idempotence from the row, never a clock).
 */
export class FormDraftConflictError extends ApiRefusalError {
  constructor(
    /** The revision the server holds now. */
    readonly revision: number,
    /** The client id of the save that wrote it; null when the revision was closed or never named one. */
    readonly saveId: string | null,
    /** The last save ids that wrote the revision (its bounded ancestry), oldest first. */
    readonly recentSaveIds: string[] = []
  ) {
    super(409, FORM_DRAFT_CONFLICT, `The form revision moved to ${revision}`);
    this.name = 'FormDraftConflictError';
  }
}
