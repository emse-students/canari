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

/** Maximum active devices per user. Exceeding this limit blocks device registration. */
export const MAX_DEVICES_PER_USER = 15;

/**
 * Duration after which a `pending` DeviceGroupMembership invitation that never transitioned
 * to `active` is considered stuck and purged, to bound the re-invitation loop on the active
 * members side (`getPendingInvitations` re-lists it on every sync).
 *
 * Deliberately DISTINCT and much shorter than {@link RETENTION_WINDOW_MS}: deleting a
 * `pending` row does NOT prevent a still-alive device from joining. The `pending` row is
 * only the inviter-side trigger (and a durable fallback); the queued Welcome (separate
 * table, 90-day retention) and the `welcome_request` path (the device remains a `GroupMember`
 * at the user level) ensure recovery without a new commit in the common case. We therefore
 * only keep a window long enough for the initial add to complete even if all members are
 * offline for a few days (weekend), then we purge.
 */
export const STALE_PENDING_INVITATION_MS = 14 * 24 * 60 * 60 * 1000;
