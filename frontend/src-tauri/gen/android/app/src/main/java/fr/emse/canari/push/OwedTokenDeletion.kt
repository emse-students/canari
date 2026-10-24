package fr.emse.canari.push

/**
 * The ORDER of the FCM token deletion a sign-out owes, with no Android in it so the JVM suite
 * (`android-tests`) runs it - the platform calls are [Ops], supplied by `PushRegistrationEnd`.
 *
 * ONE DELETION AT A TIME, PROCESS-WIDE. Four callers can owe it at once - the sign-out itself,
 * `startPushService`'s check, `MainActivity.onCreate` and the boot receiver - and two interleaved
 * runs could each delete a token and fetch a fresh one, so the token the next registration reads
 * would be whichever fetch landed last, possibly one a later deletion already killed. Under [lock]:
 *
 * 1. the owed mark is read INSIDE the lock, so a caller that waited finds the work done and returns;
 * 2. the token is deleted, its mirror forgotten, the mark removed;
 * 3. the fresh token is fetched and mirrored INSIDE the lock, so no other deletion runs between the
 *    fetch and the mirror and the mirror always names the live token.
 */
object OwedTokenDeletion {
    /** The platform steps, each blocking. Every failure is logged by the implementation. */
    interface Ops {
        /** Whether the owed mark is on disk. */
        fun isOwed(): Boolean

        /** Deletes the FCM token; false when FCM did not confirm it. */
        fun deleteToken(): Boolean

        /** Drops the token mirror `get_fcm_token` reads. */
        fun forgetTokenMirror()

        /** Removes the owed mark; false when it is still on disk. */
        fun removeOwedMark(): Boolean

        /** Fetches the fresh token and mirrors it; a failure leaves no mirror, and the next launch fetches it. */
        fun fetchAndMirrorFreshToken()
    }

    private val lock = Any()

    /**
     * Completes the owed deletion if one is owed. Returns whether no deletion is owed any more:
     * false leaves the mark for the next launch, foreground or registration.
     */
    fun complete(ops: Ops): Boolean = synchronized(lock) {
        if (!ops.isOwed()) return true
        if (!ops.deleteToken()) return false
        // A launch may have mirrored the old token while the deletion was owed; it is dead now.
        ops.forgetTokenMirror()
        if (!ops.removeOwedMark()) return false
        ops.fetchAndMirrorFreshToken()
        true
    }
}
