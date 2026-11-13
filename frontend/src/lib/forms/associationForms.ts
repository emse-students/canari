import { listAssociationForms } from '$lib/associations/api';
import { getForm, getForms, type Form } from '$lib/forms/api';
import { Log } from '$lib/utils/Log';

/**
 * THE FORMS OF ONE ASSOCIATION, as full `Form` rows - what the unified management list draws.
 *
 * The association's own route (`GET /associations/:id/forms`) is the AUTHORITY on which forms
 * belong to it: it also admits a global admin or a super-admin who holds no `MANAGE_FORMS` flag,
 * and those are in no `GET /forms` list. But it returns a thin row (no questions, no association
 * name, no unpublished-changes flag), and the list needs the whole form for the export menu and
 * the responses accordion. So the rows come from `GET /forms` when the caller's list holds them
 * (the ordinary case: one request more, no per-form call), and a form that list lacks is read by
 * id - a distinct population (an admin who is not a form manager), logged at `debug`, never a
 * silent substitute for a failing list.
 */
export async function loadAssociationForms(associationId: string): Promise<Form[]> {
  const [owned, mine] = await Promise.all([listAssociationForms(associationId), getForms()]);
  const byId = new Map(mine.map((f) => [f.id, f]));
  const missing = owned.filter((f) => !byId.has(f.id));
  if (missing.length > 0) {
    Log.d(
      'associationForms',
      `${missing.length} form(s) of ${associationId} are not in GET /forms`
    );
  }
  const extra = new Map(
    (await Promise.all(missing.map((f) => getForm(f.id)))).map((f) => [f.id, f] as const)
  );
  // The association route's order (newest first) is kept.
  return owned.map((f) => byId.get(f.id) ?? extra.get(f.id)!);
}
