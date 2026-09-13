import { m } from '$lib/paraglide/messages';
import { ensureMyAssociations } from '$lib/associations/api';
import { isGlobalAdmin, isContentModerator } from '$lib/stores/user';

/**
 * WHO MAY OPEN `/admin`, ASKED IN ONE PLACE.
 *
 * Two screens asked it and gave two answers. `routes/admin/+layout.svelte` admitted an association
 * admin OR a content moderator; `routes/dashboard/+page.svelte` offered the card on
 * `mine.some((a) => a.isAdmin)` alone. A BDE content moderator who administers no association could
 * therefore reach the console - by typing the URL - and was never offered the way in, which is the
 * worst of the two failures: a right nobody can find is a right nobody has.
 *
 * The membership probe is `ensureMyAssociations`, not `listMyAssociations`: it publishes every
 * BDE-derived flag from the one answer, so `isContentModerator()` below is resolved rather than
 * racing. A global admin short-circuits before the probe - they hold every tier by definition, and
 * asking would only add a request that cannot change the answer.
 */
export async function ensureMayOpenAdmin(): Promise<boolean> {
  if (isGlobalAdmin()) return true;
  const mine = await ensureMyAssociations();
  return mine.some((a) => a.isAdmin) || isContentModerator();
}

/** The heading and the sentence under it, which must always be chosen together. */
export interface AdminScopeLabels {
  title: () => string;
  description: () => string;
}

/**
 * WHAT THE CONSOLE IS CALLED, FOR THE READER LOOKING AT IT.
 *
 * "Administration" promised a platform console and delivered one read-only queue: for everyone who
 * is not a global admin, `/admin` is where "Agenda en attente" lives, and the server agrees - the
 * pending listing accepts an association admin, `canValidate` comes back false for them, and
 * validate/reject refuse anyone who is not BDE or global admin. There was never an access defect
 * here, only a name.
 *
 * The description already told the truth ("Moderation de l'agenda de vos associations"), so the
 * heading follows the description rather than the description being questioned. They are returned
 * TOGETHER, from one predicate, because a heading and its subtitle that branch separately are two
 * places to change and one to forget.
 *
 * For a BDE super-admin the non-global wording under-promises - they also hold the reviewer grants
 * and the cartography, both named by the "Communaute" group in the nav. Under-promising is not the
 * defect being fixed, and splitting a third tier here is a question the user has not been asked.
 */
export function adminScopeLabels(globalAdmin: boolean): AdminScopeLabels {
  return globalAdmin
    ? { title: m.admin_title, description: m.admin_global_description }
    : { title: m.admin_moderation_title, description: m.admin_associations_description };
}
