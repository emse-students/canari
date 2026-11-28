package fr.emse.canari

import android.content.Context
import android.util.Log
import fr.emse.canari.NativeMailWatcher.CheckOutcome
import fr.emse.canari.mail.MailPushRoute
import fr.emse.canari.mail.MailSummary
import fr.emse.canari.mail.forgetApplies
import java.util.concurrent.atomic.AtomicBoolean

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
 *   sealed copy erased, every native run stopped. Asynchronous (the vault's one executor). A forget
 *   for an ended session applies only when that session's registration is this device's current one
 *   or the device is signed out ([forgetApplies]).
 */
object MailPushHandoff {
    private const val TAG = "CanariMailPush"

    /** Handles one mail push. A [MailPushRoute.Check] blocks on the network: never the main thread. */
    fun handle(context: Context, route: MailPushRoute) {
        when (route) {
            MailPushRoute.Check -> {
                var outcome = checkCounted(context)
                if (outcome == CheckOutcome.BUSY) {
                    // The running check read BEFORE this push's mail may have arrived: ask it for one
                    // more pass, then try once - if the runner ended meanwhile, this check is the pass.
                    requestedAgain.set(true)
                    outcome = checkCounted(context)
                    if (outcome == CheckOutcome.BUSY) {
                        Log.i(TAG, "mail push: a check runs - it makes one more pass")
                        return
                    }
                }
                while (outcome == CheckOutcome.DONE && requestedAgain.getAndSet(false)) {
                    Log.i(TAG, "mail push: another push came during the check - one more pass")
                    outcome = checkCounted(context)
                }
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
                val signedOut = PushRegistrationEnd.isSignedOut(context)
                val secret = if (route.registration == null || signedOut) null else PushSecretKeystore.retrieve(context)
                if (!forgetApplies(route, secret, signedOut)) {
                    // An ended session that is not this device's current one: it signed in again.
                    Log.i(TAG, "mail-forget: another registration ended (secretRead=${secret != null}) - the mailbox stays")
                    return
                }
                NativeMailWatcher.forget(context, route.userId)
                Log.i(TAG, "mail-forget: the native forget is queued for the named account (conditional=${route.registration != null})")
            }
            MailPushRoute.ForgetWithoutAccount ->
                Log.e(TAG, "mail-forget without an account - nothing erased")
        }
    }

    /** A push that came while a check ran (BUSY): the running check makes one more pass. */
    private val requestedAgain = AtomicBoolean(false)

    private const val METRICS_PREFS = "canari_mail_push_metrics"

    /**
     * One [NativeMailWatcher.checkOnce], COUNTED: a DONE that left every cursor where it was read
     * nothing new - an EMPTY push (the account's notice fired for a mail the page or an earlier push
     * already took, or for a mail our rule saw but the inbox query does not). Both counts are logged
     * at each push, so the MAIL-N reading (docs/wiki/backlog.d/mail-lot5-fast-push.md) takes the
     * ratio from logcat. The counts carry nothing of the mailbox.
     */
    private fun checkCounted(context: Context): CheckOutcome {
        val before = cursorsSnapshot(context)
        val outcome = NativeMailWatcher.checkOnce(context)
        if (outcome == CheckOutcome.DONE) {
            val prefs = context.getSharedPreferences(METRICS_PREFS, Context.MODE_PRIVATE)
            val empty = cursorsSnapshot(context) == before
            val done = prefs.getLong("done", 0) + 1
            val emptyCount = prefs.getLong("empty", 0) + if (empty) 1 else 0
            prefs.edit().putLong("done", done).putLong("empty", emptyCount).apply()
            Log.i(TAG, "mail push metric: empty=$empty doneTotal=$done emptyTotal=$emptyCount") // log-safe: a boolean and two counters
        }
        return outcome
    }

    /** The shared cursors' texts (`cursor_<id>.json`), to tell whether a check moved one. */
    private fun cursorsSnapshot(context: Context): Map<String, String> {
        val dir = MailWatchVault.cursorFile(context, "probe").parentFile ?: return emptyMap()
        return dir.listFiles { f -> f.name.startsWith("cursor_") && f.name.endsWith(".json") }
            ?.associate { it.name to it.readText() } ?: emptyMap()
    }

    private fun postGeneric(context: Context) {
        // The app's language (Canari's Français/English setting), not the phone's.
        val text = appLocaleContext(context).getString(R.string.notif_mail_generic)
        MailWatchBridge.postSummary(context, MailSummary(1, text, "", text, "fr.emse.canari://mail"))
    }
}
