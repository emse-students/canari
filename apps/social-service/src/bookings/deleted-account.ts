/**
 * The id a deleted account leaves behind in a bookings row - the same tombstone
 * `InternalController.deleteUserData` writes in every other social table, so one reader can tell
 * "a deleted account" apart everywhere. Migration 087's partial unique index on
 * `booking_participants` names this literal too.
 */
export const DELETED_ACCOUNT_ID = '[deleted]';
