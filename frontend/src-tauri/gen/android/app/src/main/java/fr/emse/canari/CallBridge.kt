package fr.emse.canari

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import fr.emse.canari.call.CallServiceCommand
import fr.emse.canari.call.OngoingCallSpec
import fr.emse.canari.call.SpecResult
import org.json.JSONException
import org.json.JSONObject

/**
 * THE WEB LAYER'S HANDLE ON [CallForegroundService], AND THE SERVICE'S WAY BACK TO THE PAGE
 * (WP-C-BG-A).
 *
 * Down: `MainActivity` registers [JsInterface] as `window.canariCall` - `start(json)`, `update(json)`,
 * `stop(reason)`, `pageLoaded()` - ONLY in a build whose manifest declares the service (the `calls`
 * manifest overlay, see `app/build.gradle.kts`). The page reads the absence of `canariCall` as "this
 * build cannot keep a call alive in the background" and says so at error level when it is placing
 * calls (`frontend/src/lib/mobile/androidCallService.ts`).
 *
 * Up: every outcome reaches the page as ONE DOM event, `canari:call-native`, whose `detail.kind` is
 * `started`, `failed` (with a `code`: [CODE_OFF_SCREEN] or [CODE_REFUSED]), `stopped` (the service
 * left on its own, unexpectedly), `hangup` (the notification's button - the service has ALREADY left
 * the foreground, the page ends the call) or `foreground` (the activity resumed while a start refused
 * for being off screen was pending: the page may ask once more).
 *
 * Nothing here retries or substitutes: a refused start is reported with its reason and the call goes
 * on in the foreground only, exactly as before this service existed - which the page logs.
 */
object CallBridge {
    private const val TAG = "CallBridge"

    /** The DOM event the page listens to. Its twin is `NATIVE_CALL_EVENT` in `androidCallService.ts`. */
    const val EVENT = "canari:call-native"

    /** A start refused because the activity was not resumed: the page may ask again on `foreground`. */
    const val CODE_OFF_SCREEN = "off-screen"

    /** Any other refusal: the page does not ask again for this call. */
    const val CODE_REFUSED = "refused"

    /** The live page, set by `MainActivity.onWebViewCreate`, cleared by its `onDestroy`. Main thread. */
    @Volatile private var webView: WebView? = null

    /** A start was refused for [CODE_OFF_SCREEN] and the activity has not resumed since. */
    @Volatile private var offScreenRefusalPending = false

    fun attach(view: WebView) {
        webView = view
    }

    /** Clears [view] only if it is still the attached one: a relaunched activity attaches first. */
    fun detach(view: WebView) {
        if (webView === view) webView = null
    }

    /** Whether a page is attached - the service's hang-up has nowhere to go without one. */
    fun hasPage(): Boolean = webView != null

    /**
     * `MainActivity.onResume`. A start refused for being off screen (the first call's microphone
     * prompt, a dial and an instant HOME) can now be asked again - told by an EVENT, the resume
     * itself, never by a clock. One event per refusal.
     */
    fun onActivityResumed() {
        if (!offScreenRefusalPending) return
        offScreenRefusalPending = false
        Log.i(TAG, "resumed with an off-screen refusal pending - telling the page it may start again")
        emit("foreground")
    }

    /**
     * Whether THIS build declares the service. The `calls` manifest overlay is merged only into a
     * build that places calls, so a store build answers false and registers no bridge.
     */
    fun serviceDeclared(context: Context): Boolean = try {
        context.packageManager.getServiceInfo(ComponentName(context, CallForegroundService::class.java), 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    /**
     * Sends one event to the page. `detail` is built with [JSONObject], whose `toString()` is valid
     * JavaScript, so no field is spliced into the script as text.
     */
    fun emit(kind: String, reason: String? = null, code: String? = null) {
        val view = webView
        if (view == null) {
            Log.w(TAG, "event $kind (${reason ?: "-"}) not delivered: no page is attached")
            return
        }
        val detail = JSONObject().put("kind", kind)
        if (reason != null) detail.put("reason", reason)
        if (code != null) detail.put("code", code)
        val script = "window.dispatchEvent(new CustomEvent('$EVENT',{detail:$detail}))"
        view.post { view.evaluateJavascript(script, null) }
    }

    /**
     * `window.canariCall`. Called on a JavaScript binder thread; every method returns at once and
     * reports through [emit].
     */
    class JsInterface(private val context: Context) {
        @JavascriptInterface
        fun start(json: String) {
            val spec = parse(json, "start") ?: return
            // ANDROID GRANTS A MICROPHONE SERVICE ONLY TO AN APP THAT IS ON SCREEN: started from the
            // background, `startForeground` with type `microphone` throws (API 34+) or the service
            // runs with no microphone capability (API 30-33). RESUMED is the stricter reading of "on
            // screen" (a paused activity can still be visible, under a permission dialog), chosen
            // because it is the one fact this process holds; a refusal for it is answered by the
            // next resume ([onActivityResumed]), so being strict costs a short delay, never the call.
            if (!MainActivity.isInForeground) {
                offScreenRefusalPending = true
                Log.w(TAG, "start refused: the app is not resumed - waiting for the next resume")
                emit("failed", "start: the app is not on screen", CODE_OFF_SCREEN)
                return
            }
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                refuse("start", "RECORD_AUDIO is not granted - a microphone service cannot start")
                return
            }
            // A PLAIN `startService`, never `startForegroundService`: the app is on screen (checked
            // above), so Android lets it start a service, and the service then enters the foreground
            // itself. A refused `startForeground` is then an exception the service logs and reports -
            // where after `startForegroundService` the system would count the service stopping
            // without `startForeground` as a crash of the whole process.
            try {
                context.startService(CallForegroundService.intentFor(context, CallServiceCommand.Start(spec)))
                Log.i(TAG, "start sent (connected=${spec.connectedAtMs != null} speaker=${spec.speaker})")
            } catch (e: IllegalStateException) {
                refuse("start", "startService: ${e.message}")
            }
        }

        @JavascriptInterface
        fun update(json: String) {
            val spec = parse(json, "update") ?: return
            deliver(CallServiceCommand.Update(spec), "update")
        }

        @JavascriptInterface
        fun stop(reason: String) {
            deliver(CallServiceCommand.Stop(reason.ifBlank { "unspecified" }), "stop")
        }

        /**
         * A page has just loaded (a reload mid-call, a renderer that crashed and came back): no call
         * exists in it, so a service still in the foreground is an ORPHAN of the page before - its
         * notification, wake lock, mode and route would outlive the call they were for. Called once
         * per page load; nothing is sent when no service runs, so a normal boot is silent.
         */
        @JavascriptInterface
        fun pageLoaded() {
            if (!CallForegroundService.running) return
            Log.w(TAG, "a page loaded while the call service ran - the call of the previous page is gone")
            deliver(CallServiceCommand.Stop("a new page loaded - the call of the previous page is gone"), "stop")
        }

        /**
         * An update or a stop goes to a service that is ALREADY in the foreground, which Android lets
         * any app reach. With no service running and the app in the background, `startService` throws
         * `IllegalStateException` - and there is then no call to update or stop, which the log says.
         */
        private fun deliver(command: CallServiceCommand, what: String) {
            try {
                context.startService(CallForegroundService.intentFor(context, command))
            } catch (e: IllegalStateException) {
                Log.w(TAG, "$what not delivered (running=${CallForegroundService.running}): ${e.message}")
            }
        }

        private fun parse(json: String, what: String): OngoingCallSpec? {
            val result = try {
                val o = JSONObject(json)
                OngoingCallSpec.of(
                    title = o.optString("title", ""),
                    text = if (o.has("text")) o.getString("text") else null,
                    connectedAtMs = if (o.isNull("connectedAtMs")) null else o.getLong("connectedAtMs"),
                    speaker = if (o.has("speaker")) o.getBoolean("speaker") else null,
                )
            } catch (e: JSONException) {
                SpecResult.Refused("not the call description: ${e.message}")
            }
            return when (result) {
                is SpecResult.Valid -> result.spec
                is SpecResult.Refused -> {
                    refuse(what, result.reason)
                    null
                }
            }
        }

        private fun refuse(what: String, reason: String) {
            Log.e(TAG, "$what refused: $reason")
            emit("failed", "$what: $reason", CODE_REFUSED)
        }
    }
}
