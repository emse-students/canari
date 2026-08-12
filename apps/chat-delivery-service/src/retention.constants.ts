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

/**
 * Per-device undelivered-queue depth above which the hourly queue report escalates from a
 * log line to a WARN.
 *
 * This is an OBSERVATION threshold, deliberately not a cap: nothing here drops a frame.
 * Dropping is what {@link RETENTION_WINDOW_MS} already does, on the only axis that is safe
 * (age), and a size cap would turn a resource problem into silent message loss - the exact
 * failure class the delivery path exists to prevent.
 *
 * The number comes from two measurements on production rather than from taste. Healthy
 * per-device backlogs sat at 84 frames or less across 52 devices; the retransmission storm
 * of 2026-08-10 put 21 597 frames on ONE device in a single hour. 2000 is therefore ~24x
 * the largest normal backlog (so ordinary traffic, an offline weekend or a slow catch-up
 * never trips it) and ~1/10 of one storm hour (so a runaway sender is named within minutes
 * instead of being found by hand a day later).
 */
export const QUEUE_DEPTH_WARN_PER_DEVICE = 2000;

/** How many of the deepest per-device queues the hourly report names. */
export const QUEUE_DEPTH_REPORT_TOP_N = 5;

/**
 * Entries kept per group in the shared history stream `history:{groupId}` (`XADD ... MAXLEN ~`).
 *
 * This is the only SHARED copy of a conversation: the per-device queue is deleted on ACK, and MLS
 * forward secrecy means the server can never re-derive a frame it did not keep. What falls off the
 * end here is recoverable only from a peer that still holds it.
 *
 * Raised from 1000 on 2026-08-12, together with the durability split that put mutations
 * (reactions, edits, deletions, read receipts) into this stream for the first time. Two reasons,
 * in this order:
 *
 *  1. **Mutations now consume the budget.** At the same cap the stream would cover strictly less
 *     wall-clock history than before - the change would have shortened the window it exists to
 *     provide.
 *  2. **1000 was already short.** Measured on production the same day: an active DM spanned 22.6
 *     hours at 1000 entries. A device offline for a weekend fell off the end, which is exactly the
 *     case the shared copy is for.
 *
 * 8000 covers several days for that same DM even assuming mutations arrive as often as messages
 * (they do not - read receipts are batched per read, not per message). Cost is bounded and small:
 * ~431 bytes an entry, so ~3.4 MB for a group that actually saturates the cap, against the 2 GB
 * `maxmemory` set in `infrastructure/docker-compose.prod.yml`. Most groups never approach it - the
 * whole instance held 1.62 MB when this was measured.
 *
 * Raising this REQUIRES the store to be durable and `maxmemory` to have headroom; see the redis
 * service definition in `docker-compose.prod.yml` and
 * `docs/wiki/protocols/history-reconciliation.md`.
 */
export const HISTORY_STREAM_MAXLEN = 8000;
