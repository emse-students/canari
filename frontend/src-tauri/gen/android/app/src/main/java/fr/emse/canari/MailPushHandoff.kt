package fr.emse.canari

import android.content.Context
import android.util.Log
import fr.emse.canari.mail.MailPushRoute
import fr.emse.canari.mail.MailSummary
import fr.emse.canari.mail.NativeWatcherAnswer

/**
 * THE MAIL PUSHES, HANDED TO THE NATIVE WATCHER (mail lot 5,
 * docs/wiki/mail-client-transport.md#as-built---lot-5), from `CanariFirebaseMessagingService`.
 *
 * The page is not running when a push arrives, so the work belongs to lot 4b's native watcher
 * (`NativeMailWatcher`: `checkOnce` reads the inbox above the cursor and posts the notices;
 * `forget` erases the sealed copy of the password and stops the watcher). THAT WATCHER IS NOT ON THIS
 * BRANCH: [nativeCheck] and [nativeForget] answer [NativeWatcherAnswer.Unavailable] until lot 4b is
 * merged, and then become one call each (the two `TODO(lot 4b)` lines). Until then:
 *
 * - a `mail` push posts ONE generic "Nouveau mail" notice (logged at warn: the degraded display is
 *   stated), replaced by the next one rather than stacked;
 * - a `mail-forget` erases nothing natively (there is nothing native to erase without lot 4b: the
 *   password lives in the page's sealed copy, which the page's own sign-out erases at the next
 *   refused refresh) and says so at warn.
 */
object MailPushHandoff {
    private const val TAG = "CanariMailPush"

    /** Handles one mail push. Quick and never throws: FCM's thread must not wait. */
    fun handle(context: Context, route: MailPushRoute) {
        when (route) {
            MailPushRoute.Check -> when (val answer = nativeCheck(context)) {
                NativeWatcherAnswer.Done -> Log.i(TAG, "mail push: the native watcher checked the inbox")
                is NativeWatcherAnswer.Failed -> {
                    Log.w(TAG, "mail push: the native check failed (${answer.code}) - the generic notice")
                    postGeneric(context)
                }
                NativeWatcherAnswer.Unavailable -> {
                    Log.w(TAG, "mail push: native watcher unavailable in this build (lot 4b owed) - the generic notice")
                    postGeneric(context)
                }
            }
            is MailPushRoute.Forget -> when (val answer = nativeForget(context, route.userId)) {
                NativeWatcherAnswer.Done -> Log.i(TAG, "mail-forget: the native mail state is erased")
                is NativeWatcherAnswer.Failed -> Log.e(TAG, "mail-forget: NOT erased (${answer.code})")
                NativeWatcherAnswer.Unavailable ->
                    Log.w(TAG, "mail-forget: native watcher unavailable in this build (lot 4b owed) - nothing native to erase")
            }
            MailPushRoute.ForgetWithoutAccount ->
                Log.e(TAG, "mail-forget without an account - nothing erased")
        }
    }

    // TODO(lot 4b): `NativeMailWatcher.checkOnce(context)`, its outcome mapped to Done/Failed.
    private fun nativeCheck(@Suppress("UNUSED_PARAMETER") context: Context): NativeWatcherAnswer =
        NativeWatcherAnswer.Unavailable

    // TODO(lot 4b): `NativeMailWatcher.forget(context)` for the account the vault names == userId.
    private fun nativeForget(
        @Suppress("UNUSED_PARAMETER") context: Context,
        @Suppress("UNUSED_PARAMETER") userId: String,
    ): NativeWatcherAnswer = NativeWatcherAnswer.Unavailable

    private fun postGeneric(context: Context) {
        val text = context.getString(R.string.notif_mail_generic)
        MailWatchBridge.postSummary(context, MailSummary(1, text, "", text, "fr.emse.canari://mail"))
    }
}
