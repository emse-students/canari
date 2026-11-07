package fr.emse.canari

import android.util.Log
import fr.emse.canari.push.NativePushLogLine
import java.time.ZoneId

/**
 * Writes the push service's WARN and ERROR lines where the in-app log can take them (2026-11-04).
 *
 * The file and its bound are Rust's (`commands/native_push_log.rs`), reached through
 * [nativeAppendPushLog] so that one in-process lock orders every append against the page's take
 * (`take_native_push_log`, `nativePushLog.ts`). The line's shape is [NativePushLogLine]'s.
 *
 * NEVER THROWS, AND NEVER LOGS THROUGH [FcmLog]: a failure here is said to logcat directly, once per
 * cause, so a broken writer cannot recurse through the logger it serves.
 */
object NativePushLog {

    private const val TAG = "NativePushLog"

    /** Whether a failure was already said, so a dead writer costs one logcat line, not one per line. */
    @Volatile private var failureSaid = false

    /** Appends one line under `dataDir`; true when written. See `lib.rs`. */
    private external fun nativeAppendPushLog(dataDir: String, line: String): Boolean

    /** Records one service line when its level is one the in-app log carries ([NativePushLogLine.records]). */
    fun record(level: Char, tag: String, message: String, error: Throwable?) {
        if (!NativePushLogLine.records(level)) return
        val context = CanariApplication.appContext() ?: return sayOnce("no application context yet")
        try {
            val line = NativePushLogLine.format(System.currentTimeMillis(), level, tag, message, error, ZoneId.systemDefault())
            if (!nativeAppendPushLog(MlsContextLoader.tauriDataDir(context).absolutePath, line)) {
                sayOnce("the native writer refused a line")
            }
        } catch (e: Throwable) {
            // UnsatisfiedLinkError included: a library without the symbol must not take the push with it.
            sayOnce("${e.javaClass.simpleName}: ${e.message}")
        }
    }

    private fun sayOnce(why: String) {
        if (failureSaid) return
        failureSaid = true
        Log.e(TAG, "the push service's lines are NOT reaching the in-app log: $why")
    }
}

/**
 * `android.util.Log` for the push service, which ALSO hands each WARN and ERROR line to
 * [NativePushLog] - imported as `Log` by `CanariFirebaseMessagingService`, so every one of its call
 * sites reaches the in-app log without being rewritten. Same signatures and return values.
 */
object FcmLog {
    const val DEBUG = Log.DEBUG
    const val INFO = Log.INFO
    const val WARN = Log.WARN
    const val ERROR = Log.ERROR

    fun d(tag: String, msg: String): Int = Log.d(tag, msg)
    fun i(tag: String, msg: String): Int = Log.i(tag, msg)

    fun w(tag: String, msg: String, tr: Throwable? = null): Int {
        NativePushLog.record('W', tag, msg, tr)
        return if (tr != null) Log.w(tag, msg, tr) else Log.w(tag, msg)
    }

    fun e(tag: String, msg: String, tr: Throwable? = null): Int {
        NativePushLog.record('E', tag, msg, tr)
        return if (tr != null) Log.e(tag, msg, tr) else Log.e(tag, msg)
    }

    fun println(priority: Int, tag: String, msg: String): Int {
        when {
            priority >= Log.ERROR -> NativePushLog.record('E', tag, msg, null)
            priority >= Log.WARN -> NativePushLog.record('W', tag, msg, null)
        }
        return Log.println(priority, tag, msg)
    }
}
