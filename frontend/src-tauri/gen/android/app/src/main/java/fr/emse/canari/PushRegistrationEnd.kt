package fr.emse.canari

import android.content.Context
import android.util.Log
import com.google.android.gms.tasks.Tasks
import com.google.firebase.messaging.FirebaseMessaging
import fr.emse.canari.push.OwedTokenDeletion
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The Android half of "a sign-out ends this device's push registration" - the Rust half, and why
 * there are two marks, is `src/commands/push_registration.rs`.
 *
 * Rust writes both marks and strips the account's push files, then calls [endForSignOutFromRust].
 * This object owns what only Android can do: erase the Keystore-wrapped push secret, and delete the
 * FCM token so FCM itself stops delivering to this install for the account that left. The deletion
 * needs the network, so it is OWED until it succeeds - [DELETION_OWED_FILE] is the durable record,
 * and every path that would otherwise republish the old token completes it first ([MainActivity],
 * [CanariBootReceiver], and `startPushService` through [completeOwedDeletionFromRust]).
 *
 * Every function here BLOCKS on FCM and must run off the main thread.
 */
object PushRegistrationEnd {
    private const val TAG = "PushRegistrationEnd"

    /** Name shared with `push_registration.rs` and `canari_push.mm` - change all three together. */
    const val SIGNED_OUT_FILE = "push_signed_out"

    /** Name shared with `push_registration.rs` and `canari_push.mm` - change all three together. */
    const val DELETION_OWED_FILE = "push_token_deletion_owed"

    /** The mirror `get_fcm_token` reads - see [MainActivity]. */
    private const val FCM_TOKEN_FILE = "fcm_token.txt"

    /** The hand-off file `store_push_secret` writes - see `push.rs`. */
    private const val PENDING_PUSH_SECRET_FILE = "pending_push_secret.txt"

    /** How long one FCM call waits. The owed mark, not this bound, is what makes the deletion complete. */
    private const val FCM_TIMEOUT_S = 30L

    /** True while no account owns this device's pushes: a push that still arrives is dropped. */
    fun isSignedOut(context: Context): Boolean =
        File(MlsContextLoader.tauriDataDir(context), SIGNED_OUT_FILE).exists()

    /** True while the token of the account that left has not been deleted. */
    fun isDeletionOwed(context: Context): Boolean =
        File(MlsContextLoader.tauriDataDir(context), DELETION_OWED_FILE).exists()

    /**
     * Called from Rust (`end_push_registration`) at a sign-out, after the marks are on disk. Erases
     * the push secret, then deletes the token. Returns whether the deletion COMPLETED.
     */
    @JvmStatic
    fun endForSignOutFromRust(): Boolean {
        val context = CanariApplication.appContext()
        if (context == null) {
            Log.e(TAG, "endForSignOut: no Application context - the token deletion stays owed")
            return false
        }
        Log.i(TAG, "endForSignOut: erasing the push secret and deleting the FCM token")
        eraseSecret(context)
        forgetTokenMirror(context)
        return completeOwedDeletion(context)
    }

    /** Called from Rust (`complete_owed_push_token_deletion`) before a registration. */
    @JvmStatic
    fun completeOwedDeletionFromRust(): Boolean {
        val context = CanariApplication.appContext()
        if (context == null) {
            Log.e(TAG, "completeOwedDeletion: no Application context - the token deletion stays owed")
            return false
        }
        return completeOwedDeletion(context)
    }

    /**
     * Deletes the FCM token if [DELETION_OWED_FILE] says it is owed, then fetches the fresh token
     * the next sign-in will register - one caller at a time, in the order [OwedTokenDeletion]
     * fixes. Returns whether no deletion is owed any more. A failure is logged and leaves the mark
     * for the next launch, foreground or registration.
     */
    fun completeOwedDeletion(context: Context): Boolean = OwedTokenDeletion.complete(FcmOps(context))

    /**
     * Erases the push secret: the pending hand-off file (Rust removed it already; a second removal
     * is free) and then the Keystore copy, under [PushSecretKeystore.handoffLock] so an adoption
     * that read the file earlier has either finished - and is cleared here - or finds nothing.
     */
    private fun eraseSecret(context: Context) = synchronized(PushSecretKeystore.handoffLock) {
        val pending = File(MlsContextLoader.tauriDataDir(context), PENDING_PUSH_SECRET_FILE)
        if (pending.exists() && !pending.delete()) {
            Log.e(TAG, "eraseSecret: $PENDING_PUSH_SECRET_FILE not removed")
        }
        PushSecretKeystore.clear(context)
    }

    /** Drops the token mirror, file and preference, so nothing registers a token that is gone. */
    private fun forgetTokenMirror(context: Context) {
        val file = File(MlsContextLoader.tauriDataDir(context), FCM_TOKEN_FILE)
        if (file.exists() && !file.delete()) {
            Log.e(TAG, "forgetTokenMirror: $FCM_TOKEN_FILE not removed")
        }
        context.getSharedPreferences(CanariFirebaseMessagingService.PREFS_NAME, Context.MODE_PRIVATE)
            .edit().remove(CanariFirebaseMessagingService.KEY_FCM_TOKEN).apply()
    }

    /** The FCM and file steps [OwedTokenDeletion] orders. Every call blocks. */
    private class FcmOps(private val context: Context) : OwedTokenDeletion.Ops {
        private val owed get() = File(MlsContextLoader.tauriDataDir(context), DELETION_OWED_FILE)

        override fun isOwed(): Boolean = owed.exists()

        override fun deleteToken(): Boolean = try {
            Tasks.await(FirebaseMessaging.getInstance().deleteToken(), FCM_TIMEOUT_S, TimeUnit.SECONDS)
            true
        } catch (e: Exception) {
            Log.e(TAG, "completeOwedDeletion: FCM deleteToken failed - still owed: ${e.javaClass.simpleName}: ${e.message}")
            false
        }

        override fun forgetTokenMirror() = forgetTokenMirror(context)

        override fun removeOwedMark(): Boolean {
            if (!owed.delete() && owed.exists()) {
                Log.e(TAG, "completeOwedDeletion: token deleted but $DELETION_OWED_FILE not removed - the next launch deletes again")
                return false
            }
            Log.i(TAG, "completeOwedDeletion: FCM token deleted - this install is no longer the previous account's push destination")
            return true
        }

        /**
         * Mints the token the next sign-in registers and mirrors it where `get_fcm_token` reads
         * it. No server learns it here: the stripped push context is what keeps `onNewToken` from
         * refreshing it on the backend.
         */
        override fun fetchAndMirrorFreshToken() {
            val token = try {
                Tasks.await(FirebaseMessaging.getInstance().token, FCM_TIMEOUT_S, TimeUnit.SECONDS)
            } catch (e: Exception) {
                Log.w(TAG, "fetchFreshToken: FCM refused - the next launch fetches it: ${e.message}")
                return
            }
            if (token.isNullOrEmpty()) {
                Log.w(TAG, "fetchFreshToken: FCM returned an empty token - the next launch fetches it")
                return
            }
            try {
                val dataDir = MlsContextLoader.tauriDataDir(context).also { it.mkdirs() }
                File(dataDir, FCM_TOKEN_FILE).writeText(token)
                context.getSharedPreferences(CanariFirebaseMessagingService.PREFS_NAME, Context.MODE_PRIVATE)
                    .edit().putString(CanariFirebaseMessagingService.KEY_FCM_TOKEN, token).apply()
                Log.i(TAG, "fetchFreshToken: fresh token mirrored for the next registration")
            } catch (e: Exception) {
                Log.e(TAG, "fetchFreshToken: unable to write $FCM_TOKEN_FILE: ${e.message}")
            }
        }
    }
}
