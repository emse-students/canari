import { m } from '$lib/paraglide/messages';
import { ensureMyAssociations } from '$lib/associations/api';
import {
  isGlobalAdmin,
  isAssociationSuperAdmin,
  isContentModerator,
  isEventValidator,
} from '$lib/stores/user';

/**
 * WHO MAY OPEN `/admin`, ASKED IN ONE PLACE.
 *
 * The shell admits only accounts with an actionable panel: platform admin, BDE super-admin,
 * content moderator, or event validator. Association administration alone is not enough because
 * its former pending-agenda read path no longer exposes actions to that tier.
 *
 * The membership probe is `ensureMyAssociations`, not `listMyAssociations`: it publishes every
 * BDE-derived flag from the one answer, so the three capabilities below are resolved rather than
 * racing. A global admin short-circuits before the probe - they hold every tier by definition, and
 * asking would only add a request that cannot change the answer.
 */
export async function ensureMayOpenAdmin(): Promise<boolean> {
  if (isGlobalAdmin()) return true;
  await ensureMyAssociations();
  return isAssociationSuperAdmin() || isContentModerator() || isEventValidator();
}

/** The heading and the sentence under it, which must always be chosen together. */
export interface AdminScopeLabels {
  title: () => string;
  description: () => string;
}

/**
 * WHAT THE CONSOLE IS CALLED, FOR THE READER LOOKING AT IT.
 *
 * "Administration" promises a platform console, so it is reserved for accounts that can act on at
 * least one panel. The pending agenda is only offered to event validators, while other tiers have
 * their own guarded panels.
 *
 * THE DESCRIPTION NAMES NO SINGLE QUEUE (2026-11-27, read on dev as a space moderator): it sits on
 * the dashboard row whose badge is the SUM of every queue the reader may act on
 * (`adminQueueCounts.total` - reports, agenda, corrections, duplicates), and "Moderation de l'agenda"
 * over a count of reports told the reader the wrong thing. They are returned TOGETHER, from one
 * predicate, because a heading and its subtitle that branch separately are two places to change and
 * one to forget.
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
