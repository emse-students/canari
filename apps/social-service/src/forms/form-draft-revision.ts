import type { EntityManager } from 'typeorm';

/**
 * THE UNPUBLISHED REVISION OF A FORM (owner, 2026-11-08; migration 146).
 *
 * The editor saves what the manager types into `form_drafts.document`, as typed, while the form's
 * own row keeps serving respondents. "Publier les modifications" applies the document with the
 * edit's own rules, in one transaction; "Abandonner les modifications" empties it. Each write names
 * the `revision` it was built on (compare-and-set), and the counter only grows, so a tab holding an
 * old number is refused instead of overwriting - or resurrecting - what another tab did.
 */

/** The 409 refusing a save, a publication or a discard built on a revision that has since moved. */
export const FORM_DRAFT_CONFLICT = 'FORM_DRAFT_CONFLICT';

/** The 409 refusing to publish changes when no unpublished revision holds any. */
export const FORM_DRAFT_EMPTY = 'FORM_DRAFT_EMPTY';

/** The 400 refusing a revision document the edit route would refuse (its validation messages ride along). */
export const FORM_DRAFT_INVALID = 'FORM_DRAFT_INVALID';

/**
 * The 409 refusing to publish a revision when the form itself was written since the revision started
 * (an older build editing it directly): publishing would silently undo that write. The manager may
 * confirm the overwrite (`overwrite: true`).
 */
export const FORM_CHANGED_SINCE_REVISION = 'FORM_CHANGED_SINCE_REVISION';

/** The 409 refusing a create whose client-minted id is another account's form. */
export const FORM_ID_TAKEN = 'FORM_ID_TAKEN';

/** The 400 refusing a document that is not an object, or is larger than a form ever is. */
export const FORM_DRAFT_MALFORMED = 'FORM_DRAFT_MALFORMED';

/**
 * The largest document stored, as JSON characters. The editor's whole payload - questions, grids,
 * descriptions - is a few tens of kilobytes; this only bounds a client gone wrong.
 */
export const FORM_DRAFT_MAX_CHARS = 1_000_000;

/** What the editor reads back: revision 0 and no document when nothing was ever saved. */
export interface FormDraftState {
  revision: number;
  document: Record<string, unknown> | null;
  savedAt: string | null;
  /** The client's id of the save that wrote this revision, null before the first or after a close. */
  saveId: string | null;
}

/**
 * The form's own content as one md5: every column of `forms` but its ids, its dates, its status and
 * its cover image (uploaded on its own route, never part of a revision). `to_jsonb` of a row prints
 * its keys in one canonical order, and a column added later is covered without touching this.
 */
const FORM_FINGERPRINT_SQL = `md5((to_jsonb(f) - ARRAY['id', 'ownerId', 'createdAt', 'updatedAt', 'deletedAt', 'closedAt', 'status', 'imageUrl', 'imageMediaId'])::text)`;

type Querier = Pick<EntityManager, 'query'>;

/**
 * The rows a `RETURNING` statement gave back: TypeORM answers an INSERT with the rows, but an UPDATE
 * with `[rows, affected]`.
 */
function returned<T>(result: unknown): T[] {
  const r = result as unknown[];
  return (Array.isArray(r[0]) ? r[0] : r) as T[];
}

/** Reads the revision of `formId`; `lock` takes the row for the caller's transaction. */
export async function readFormDraft(
  m: Querier,
  formId: string,
  lock = false
): Promise<FormDraftState> {
  const rows = (await m.query(
    `SELECT revision, document, "savedAt", "saveId" FROM form_drafts WHERE "formId" = $1${lock ? ' FOR UPDATE' : ''}`,
    [formId]
  )) as Array<{
    revision: number;
    document: Record<string, unknown> | null;
    savedAt: Date;
    saveId: string | null;
  }>;
  const row = rows[0];
  if (!row) return { revision: 0, document: null, savedAt: null, saveId: null };
  return {
    revision: Number(row.revision),
    document: row.document ?? null,
    savedAt: new Date(row.savedAt).toISOString(),
    saveId: row.saveId ?? null,
  };
}

/**
 * Whether the form was written since its open revision started (its content no longer matches the
 * fingerprint taken then). Takes the form's row for the caller's transaction, so nothing writes it
 * between this answer and the publication.
 */
export async function formChangedSinceRevision(m: Querier, formId: string): Promise<boolean> {
  const rows = (await m.query(
    `SELECT ${FORM_FINGERPRINT_SQL} IS DISTINCT FROM d."baseFingerprint" AS changed
       FROM forms f JOIN form_drafts d ON d."formId" = f.id
      WHERE f.id = $1
        FOR UPDATE OF f`,
    [formId]
  )) as Array<{ changed: boolean }>;
  return rows[0]?.changed === true;
}

/**
 * Stores `document` as the revision after `baseRevision`, in ONE statement either way: the first
 * save of a form (base 0) inserts and does nothing when a row already exists; every later one
 * updates only while the row still holds `baseRevision`. `saveId` is kept on the row (a client whose
 * answer was lost finds it in the 409). A revision that STARTS here - the first, or the first after
 * a publication or a discard - takes the form's fingerprint as its base. Returns the new state, or
 * `null` when the base has moved (the caller answers 409 with the current one).
 */
export async function writeFormDraft(
  m: Querier,
  formId: string,
  baseRevision: number,
  document: Record<string, unknown>,
  saveId: string | null
): Promise<{ revision: number; savedAt: string } | null> {
  const json = JSON.stringify(document);
  const fingerprint = `(SELECT ${FORM_FINGERPRINT_SQL} FROM forms f WHERE f.id = $1)`;
  const result =
    baseRevision === 0
      ? await m.query(
          `INSERT INTO form_drafts ("formId", revision, document, "savedAt", "saveId", "baseFingerprint")
             VALUES ($1, 1, $2::jsonb, now(), $3, ${fingerprint})
           ON CONFLICT ("formId") DO NOTHING
           RETURNING revision, "savedAt"`,
          [formId, json, saveId]
        )
      : await m.query(
          `UPDATE form_drafts
              SET revision = revision + 1, document = $2::jsonb, "savedAt" = now(), "saveId" = $4,
                  "baseFingerprint" = CASE WHEN document IS NULL THEN ${fingerprint}
                                           ELSE "baseFingerprint" END
            WHERE "formId" = $1 AND revision = $3
           RETURNING revision, "savedAt"`,
          [formId, json, baseRevision, saveId]
        );
  const row = returned<{ revision: number; savedAt: Date }>(result)[0];
  return row
    ? { revision: Number(row.revision), savedAt: new Date(row.savedAt).toISOString() }
    : null;
}

/**
 * Empties the revision after it was published or discarded, bumping the counter: an editor still
 * holding the old number is refused, never handed a fresh revision on top of the new form.
 * The caller holds the row (`readFormDraft(.., lock)`) in the same transaction.
 */
export async function closeFormDraft(m: Querier, formId: string): Promise<number> {
  const result = await m.query(
    `UPDATE form_drafts
        SET document = NULL, revision = revision + 1, "savedAt" = now(), "saveId" = NULL,
            "baseFingerprint" = NULL
      WHERE "formId" = $1 RETURNING revision`,
    [formId]
  );
  return Number(returned<{ revision: number }>(result)[0]?.revision ?? 0);
}

/** Of `formIds`, those holding an unpublished revision: the managers' list marks them. */
export async function formsWithUnpublishedChanges(
  m: Querier,
  formIds: string[]
): Promise<Set<string>> {
  if (formIds.length === 0) return new Set();
  const rows = (await m.query(
    `SELECT "formId" FROM form_drafts WHERE "formId" = ANY($1::uuid[]) AND document IS NOT NULL`,
    [formIds]
  )) as Array<{ formId: string }>;
  return new Set(rows.map((r) => r.formId));
}

/** Whether `document` may be stored: a plain object, within {@link FORM_DRAFT_MAX_CHARS}. */
export function isStorableDraftDocument(document: unknown): document is Record<string, unknown> {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
  return JSON.stringify(document).length <= FORM_DRAFT_MAX_CHARS;
}
