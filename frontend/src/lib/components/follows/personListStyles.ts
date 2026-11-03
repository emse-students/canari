/**
 * The look the lists of people share - the followers and sent requests (`ProfileFollowersSection`),
 * the blocked accounts (`SettingsBlockedSection`) and the reposters of a post
 * (`PostRepostersSheet`): ONE definition, so the three cannot drift apart.
 */

/** A row's own action ("Retirer", "Débloquer", "Annuler"): small, quiet, disabled while in flight. */
export const PERSON_ROW_BUTTON =
  'text-text-main shrink-0 rounded-lg bg-black/5 px-3 py-1.5 text-xs font-bold transition-colors hover:bg-black/10 disabled:opacity-50 dark:bg-white/10 dark:hover:bg-white/20';

/** The sentence a list shows when it could not be read, or a row's action was refused. */
export const PERSON_LIST_ERROR =
  'rounded-xl bg-red-500/10 px-4 py-3 text-sm font-medium text-red-600';
