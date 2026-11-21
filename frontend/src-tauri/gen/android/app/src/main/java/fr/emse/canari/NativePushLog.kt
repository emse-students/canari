package fr.emse.canari

import android.util.Log
import fr.emse.canari.push.NativePushLogLine
import java.time.ZoneId

/**
 * Writes the push service's WARN and ERROR lines, and its deliberately recorded INFO lines, where the in-app log can take them (2026-11-04).
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

    /**
     * Appends one line under `dataDir`; true when written. [info] stores it in the recorded-INFO
     * stream, whose own budget can never evict a WARN or ERROR line. See `lib.rs`.
     */
    private external fun nativeAppendPushLog(dataDir: String, line: String, info: Boolean): Boolean

    /** Records one service line when its level is one the in-app log carries ([NativePushLogLine.records]). */
    fun record(level: Char, tag: String, message: String, error: Throwable?) {
        if (!NativePushLogLine.records(level)) return
        append(level, tag, message, error)
    }

    /**
     * Records one INFO line, past the level gate, ON PURPOSE: a decision the in-app log must carry
     * though nothing is wrong (`PushShowOutcome`, 2026-11-20). Only [FcmLog.iRecorded] calls it, so
     * an ordinary `Log.i` still stays in logcat, and no WARN is spent on a line that accuses nothing.
     */
    fun recordInfo(tag: String, message: String) = append('I', tag, message, null)

    private fun append(level: Char, tag: String, message: String, error: Throwable?) {
        val context = CanariApplication.appContext() ?: return sayOnce("no application context yet")
        try {
            val line = NativePushLogLine.format(System.currentTimeMillis(), level, tag, message, error, ZoneId.systemDefault())
            if (!nativeAppendPushLog(MlsContextLoader.tauriDataDir(context).absolutePath, line, level == 'I')) {
                sayOnce("the native writer refused a line")
            }
        } catch (e: Throwable) {
            // UnsatisfiedLinkError included: a library without the symbol must not take the push with it.
            sayOnce("${e.javaClass.simpleName}: ${e.message}") // log-safe: the JNI append (a missing symbol) or the line format; neither quotes the line
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

    /**
     * An INFO line the in-app log ALSO records ([NativePushLog.recordInfo]) - the deliberate path for
     * an outcome a member's export must show although it is not a warning. Use it for one line per
     * decision, never in a loop: the file is bounded at 64 KiB and shared with every WARN.
     */
    fun iRecorded(tag: String, msg: String): Int {
        NativePushLog.recordInfo(tag, msg)
        return Log.i(tag, msg)
    }

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
