import type { Association } from '$lib/associations/api';
import { Log } from '$lib/utils/Log';

/**
 * The association list a form builder offers, with the one the URL ASKED for guaranteed in it.
 *
 * `listMyAssociations` holds MEMBERSHIPS, so a global admin who is not a member arrived from an
 * association's own Formulaires tab to a builder with no selector and a preselected id that matched
 * nothing - and the paid toggle then claimed a form needs an association. The requested one is
 * therefore fetched by id when the memberships do not carry it. The server stays the authority: it
 * lets a global admin create for any association and refuses anyone else, so a fetched row here is
 * a choice, never a grant.
 *
 * A failed fetch is logged and leaves the list as it was - the id then matches nothing, which is
 * the same state as no id at all.
 */
export async function withRequestedAssociation(
  mine: Association[],
  requestedId: string,
  fetchOne: (id: string) => Promise<Association>
): Promise<Association[]> {
  if (!requestedId || mine.some((a) => a.id === requestedId)) return mine;
  try {
    const requested = await fetchOne(requestedId);
    Log.d('forms/create: requested association is not a membership, offering it', { requestedId });
    return [...mine, requested];
  } catch (err) {
    Log.d('forms/create: requested association could not be loaded', { requestedId, err });
    return mine;
  }
}
