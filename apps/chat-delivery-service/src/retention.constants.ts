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
 * Age past which a `pending` DeviceGroupMembership is REPORTED (never touched) by the hourly
 * stranded-membership report.
 *
 * The row alone cannot say which of two opposite situations it is in, and that ambiguity is the
 * whole reason the report exists. `registerMember` writes a `pending` row for EVERY device of the
 * invited user - each one that still has a KeyPackage inside {@link RETENTION_WINDOW_MS} - while
 * the Welcome only ever goes to the devices `addMembersBulk` actually managed to add. A device
 * whose KeyPackage was rejected is therefore left holding a roster row it was never given the keys
 * for: it looks like a member to every reader, receives nothing, and raises no notification. The
 * queued Welcome is what separates the two, so the report reads it rather than guessing.
 *
 * Measured on production 2026-09-01: a phone sat exactly like that for **3 h 41** on a
 * brand-new DM - registered at 20:45:47, no Welcome ever queued, self-healed by external join at
 * 00:26:54 - and nothing anywhere said so. It was found by reading the tables by hand.
 *
 * One hour is deliberately far above a Welcome in flight (seconds for an online device, its own
 * reconnect otherwise) and far below {@link STALE_PENDING_INVITATION_MS}, which DELETES these rows:
 * a stranded device is named roughly thirteen days before the purge erases the evidence. It also
 * matches the predicate the 2026-08-30 measurement of this population had to invent by hand
 * ("older than an hour"), which is the only calibration available until a second incident refines
 * it - and a predicate that named one incident must be re-measured before it is believed about the
 * next, which is why the report prints the whole partition and not just the offenders.
 */
export const STRANDED_PENDING_MEMBERSHIP_MS = 60 * 60 * 1000;

/** How many stranded memberships the hourly report names in its WARN line. */
export const STRANDED_MEMBERSHIP_REPORT_TOP_N = 10;

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
 * Per-device queue SIZE above which the hourly report warns, independently of the row count.
 *
 * The row threshold above could not have named the incident of 2026-08-13, and that is the whole
 * reason this exists. A phone sat at 976 undelivered frames - comfortably under 2000, so the report
 * stayed at LOG level for weeks - while those frames weighed 36 MB, because a quarter of them
 * carried media at up to 89 kB each. The queue was permanently undeliverable and the report said
 * nothing was wrong. A predicate calibrated on a retransmission storm counts rows; a backlog that
 * cannot cross a mobile link is measured in bytes, and one axis cannot answer for the other.
 *
 * 32 MB is deliberately far above a healthy backlog (the same fleet's next-deepest device held
 * 189 frames, well under a megabyte) and below the point where a device is beyond catching up.
 */
export const QUEUE_BYTES_WARN_PER_DEVICE = 32 * 1024 * 1024;

/**
 * Maximum bytes of `proto` one page of the pending queue may carry.
 *
 * A page is a UNIT OF TRANSFER, so it has to be bounded in the unit that decides how long the
 * transfer takes. Bounding it in rows alone is what broke offline catch-up on 2026-08-13: the client
 * asked for 500 rows, which for that device meant 12 MB, and it aborted the request on its own 10 s
 * per-page deadline after receiving nothing. Nothing was ACKed, so the queue never shrank, so the
 * next attempt faced the same 12 MB - a closed loop no amount of retrying escapes. WP-PENDING-1
 * bounded the DEADLINE per page and left the page itself unbounded, which only moved the problem.
 *
 * 1 MB crosses even a poor mobile link well inside that deadline, and the cost of choosing it too
 * small is only more round trips - each of which now makes durable progress, because every page
 * that lands is ACKed and deleted.
 *
 * A page always carries AT LEAST ONE row, whatever its size: a single frame larger than the budget
 * must still be deliverable, or it blocks its device's queue for ever.
 */
export const PENDING_PAGE_MAX_BYTES = 1024 * 1024;

/**
 * How many rows the service reads from the database at a time while filling one page.
 *
 * Bounds the SERVICE's memory, which the page budget alone does not: reading the client's full row
 * limit and then trimming to 1 MB would have loaded up to 500 x 89 kB = 44 MB per request just to
 * discard most of it. Reading in small chunks and stopping at the budget keeps the working set to
 * this many frames, and in the common case (small frames) the first chunk already fills the page.
 */
export const PENDING_FETCH_CHUNK_ROWS = 50;

/**
 * How long a revoked device identifier stays denylisted.
 *
 * The denylist exists because `resolveDeviceId` deliberately restores the SAME identifier after a
 * reinstall - so without it, deleting a device writes a row, returns 200, and the device re-registers
 * under the id its owner just retired. The row is what makes revocation mean something; the client
 * answers it by enrolling under a fresh id (`rotateDeviceIdentity`), because an MLS credential is
 * literally `userId:deviceId` and the old one can never be reused.
 *
 * Ten years is not a security parameter, it is HYGIENE: a table that only ever grows is a table
 * nobody can reason about, and an identifier retired a decade ago cannot plausibly still be trying
 * to come back - the physical device is long gone and its owner has re-enrolled many times over.
 * The bound is enforced where it matters, at the QUESTION "is this device banned", so a row past its
 * date stops answering that question whether or not the purge has run yet; the daily purge only
 * reclaims the space. A clock alone would be a fragile mechanism, which is why it is not one here:
 * the row is durable state, and the date narrows what that state asserts rather than replacing it.
 */
export const DEVICE_REVOCATION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * Entries kept per group in the shared history stream `history:{groupId}` (`XADD ... MAXLEN ~`).
 *
 * This is the only SHARED copy of a conversation: the per-device queue is deleted on ACK, and MLS
 * forward secrecy means the server can never re-derive a frame it did not keep. What falls off the
 * end here is recoverable only from a peer that still holds it.
 *
 * **This is the MEMORY bound, and it is not the only one.** It says how MANY entries a group may
 * hold and nothing about how far back they reach, so on its own a group under the cap kept every
 * row it ever had - the TTL is refreshed on every write, so the key never expired either. The write
 * path therefore also trims by MINID at {@link RETENTION_WINDOW_MS} (`messaging.service.ts`), which
 * is the AGE bound the rest of the service already assumed: the client's own
 * `connectionSweepDecision` reasons "could the server have dropped something for me" against that
 * same window. Whichever bites first wins, and only the age one may be relied on for a date.
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
