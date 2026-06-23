/**
 * Single source of truth for the offline-recovery window across the delivery service.
 *
 * A device (and its undelivered messages / key packages) stays relevant for this long
 * after its last connection. Past this window a device is treated as gone: its queued
 * messages are purged, it is reset to `pending` for a full re-invite, and it stops
 * appearing in the device list / new-group invite candidates.
 *
 * 90 days is the standard offline window for a social network. Every consumer must use
 * THIS constant so the staleness threshold, message retention, key-package retention and
 * device-list cutoff can never drift apart (a device must not be "alive" for one and
 * "dead" for another).
 */
export const RETENTION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Duree au-dela de laquelle une invitation (DeviceGroupMembership `pending`) jamais passee
 * `active` est consideree coincee et purgee, pour borner la boucle de re-invitation cote
 * membres actifs (`getPendingInvitations` la re-liste a chaque sync).
 *
 * Volontairement DISTINCT et beaucoup plus court que {@link RETENTION_WINDOW_MS} : supprimer
 * une ligne `pending` n'empeche PAS un device encore vivant de rejoindre. La ligne `pending`
 * n'est que le declencheur cote inviteur (et un fallback durable) ; le Welcome en file (table
 * separee, retention 90j) et le chemin `welcome_request` (le device reste `GroupMember` au
 * niveau utilisateur) assurent la reprise sans nouveau commit dans le cas courant. On garde
 * donc seulement une fenetre suffisante pour que l'ajout initial ait le temps de se faire
 * meme si tous les membres sont hors-ligne quelques jours (week-end), puis on purge.
 */
export const STALE_PENDING_INVITATION_MS = 14 * 24 * 60 * 60 * 1000;
