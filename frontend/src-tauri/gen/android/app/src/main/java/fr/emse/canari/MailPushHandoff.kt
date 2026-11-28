package fr.emse.canari

import android.content.Context
import android.util.Log
import fr.emse.canari.NativeMailWatcher.CheckOutcome
import fr.emse.canari.mail.MailPushRoute
import fr.emse.canari.mail.MailSummary

/**
 * THE MAIL PUSHES, HANDED TO THE NATIVE WATCHER (mail lot 5,
 * docs/wiki/mail-client-transport.md#as-built---lot-5), from `CanariFirebaseMessagingService`.
 *
 * The page is not running when a push arrives, so the work belongs to lot 4b's native watcher:
 *
 * - a `mail` push is ONE [NativeMailWatcher.checkOnce] - the inbox above the cursor read with the
 *   sealed copy, and the same notices as the persistent run. BLOCKING: the caller runs it on a worker
 *   thread under a wake lock. When the check could not read the mailbox (nothing sealed, a refused
 *   password, an inactive account, a transport failure), ONE generic "Nouveau mail" notice is posted
 *   instead, logged at warn - the degraded display is stated, never silent;
 * - a `mail-forget` (D6) is [NativeMailWatcher.forget] for the account it names: that account's
 *   sealed copy erased, every native run stopped. Asynchronous (the vault's one executor).
 */
object MailPushHandoff {
    private const val TAG = "CanariMailPush"

    /** Handles one mail push. A [MailPushRoute.Check] blocks on the network: never the main thread. */
    fun handle(context: Context, route: MailPushRoute) {
        when (route) {
            MailPushRoute.Check -> {
                val outcome = NativeMailWatcher.checkOnce(context)
                when (outcome) {
                    CheckOutcome.DONE, CheckOutcome.WATCHING, CheckOutcome.BUSY ->
                        Log.i(TAG, "mail push: ${outcome.name} - the native watcher notifies") // log-safe: an enum constant
                    CheckOutcome.ACCOUNT_CLOSED ->
                        Log.w(TAG, "mail push: the account is closed - nothing to notify")
                    CheckOutcome.NOTHING_SEALED, CheckOutcome.REFUSED, CheckOutcome.UNAVAILABLE, CheckOutcome.FAILED -> {
                        Log.w(TAG, "mail push: the native check could not read (${outcome.name}) - the generic notice") // log-safe: an enum constant
                        postGeneric(context)
                    }
                }
            }
            is MailPushRoute.Forget -> {
                NativeMailWatcher.forget(context, route.userId)
                Log.i(TAG, "mail-forget: the native forget is queued for the named account")
            }
            MailPushRoute.ForgetWithoutAccount ->
                Log.e(TAG, "mail-forget without an account - nothing erased")
        }
    }

    private fun postGeneric(context: Context) {
        // The app's language (Canari's Français/English setting), not the phone's.
        val text = appLocaleContext(context).getString(R.string.notif_mail_generic)
        MailWatchBridge.postSummary(context, MailSummary(1, text, "", text, "fr.emse.canari://mail"))
    }
}
