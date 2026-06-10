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
