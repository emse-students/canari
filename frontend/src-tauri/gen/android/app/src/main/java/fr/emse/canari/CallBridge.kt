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
import fr.emse.canari.call.OffScreenGate
import fr.emse.canari.call.OngoingCallSpec
import fr.emse.canari.call.SpecResult
import fr.emse.canari.call.StartRefusal
import org.json.JSONException
import org.json.JSONObject

/**
 * THE WEB LAYER'S HANDLE ON [CallForegroundService], AND THE SERVICE'S WAY BACK TO THE PAGE
 * (WP-C-BG-A).
 *
 * Down: `MainActivity` registers [JsInterface] as `window.canariCall` - `start(json)`, `update(json)`,
 * `stop(callId, reason)`, `pageLoaded()` - ONLY in a build whose manifest declares the service (the
 * main manifest, since the calls flip of 2026-10-22; a build that lost the declaration registers no bridge). The page reads the absence of `canariCall` as
 * "this build cannot keep a call alive in the background" and says so at error level when it is
 * placing calls (`frontend/src/lib/mobile/androidCallService.ts`). `start` and `update` carry the
 * description and the CALL ID the page drew for this call.
 *
 * Up: every outcome reaches the page as ONE DOM event, `canari:call-native`, whose `detail` names the
 * call it is about (`callId`) and whose `kind` is `started`, `failed` (with a `code`, [StartRefusal]),
 * `stopped` (the service left on its own, unexpectedly), `hangup` (the notification's button - the
 * service has ALREADY left the foreground, the page ends the call), `mute` (the notification's mute
 * action - the page toggles its microphone and its next `update` redraws the action) or `foreground` (the activity
 * resumed while a start refused for being off screen was pending: the page may ask once more). The
 * page drops an event of another call.
 *
 * Nothing here retries or substitutes: a refused start is reported with its reason and the call goes
 * on in the foreground only, exactly as before this service existed - which the page logs.
 */
object CallBridge {
    private const val TAG = "CallBridge"

    /** The DOM event the page listens to. Its twin is `NATIVE_CALL_EVENT` in `androidCallService.ts`. */
    const val EVENT = "canari:call-native"

    /** The live page, set by `MainActivity.onWebViewCreate`, cleared by its `onDestroy`. Main thread. */
    @Volatile private var webView: WebView? = null

    /** A start refused for being off screen, answered by the next resume - see [OffScreenGate]. */
    private val offScreen = OffScreenGate()

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
     * `MainActivity.onResume`, called AFTER `isInForeground` is set (the [OffScreenGate] contract). A
     * start refused for being off screen (the first call's microphone prompt, a dial and an instant
     * HOME) can now be asked again - told by an EVENT, the resume itself, never by a clock. One event
     * per refusal.
     */
    fun onActivityResumed() {
        offScreen.resumed { callId ->
            Log.i(TAG, "resumed with an off-screen refusal pending - telling the page it may start again")
            emit("foreground", callId)
        }
    }

    /**
     * The service met an off-screen refusal itself ([fr.emse.canari.call.classifyStartRefusal]): the
     * user left the screen between the bridge's check and `startForeground`. Recorded like the bridge's
     * own, so the next resume answers it.
     */
    fun refusedOffScreen(callId: String, reason: String) {
        offScreen.refusedOffScreen(callId) {
            emit("failed", callId, reason, StartRefusal.OFF_SCREEN.code)
        }
    }

    /**
     * Whether THIS build declares the service. The main manifest carries it since the flip; a build
     * whose manifest lost it answers false and registers no bridge (the page then says so at error level).
     */
    fun serviceDeclared(context: Context): Boolean = try {
        context.packageManager.getServiceInfo(ComponentName(context, CallForegroundService::class.java), 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    /**
     * Sends one event about [callId] to the page. `detail` is built with [JSONObject], whose
     * `toString()` is valid JavaScript, so no field is spliced into the script as text. A null
     * [callId] (a description that could not be read at all) is sent without one, and the page logs
     * the event as unreadable - loud on both sides, as such a defect should be. [speaker] is the
     * `output` event's applied route: absent when the platform routes and nothing is known.
     */
    fun emit(kind: String, callId: String?, reason: String? = null, code: String? = null, speaker: Boolean? = null) {
        val view = webView
        if (view == null) {
            Log.i(TAG, "event $kind (${reason ?: "-"}) not delivered: no page is attached")
            return
        }
        val detail = JSONObject().put("kind", kind)
        if (callId != null) detail.put("callId", callId)
        if (reason != null) detail.put("reason", reason)
        if (code != null) detail.put("code", code)
        if (speaker != null) detail.put("speaker", speaker)
        val script = "window.dispatchEvent(new CustomEvent('$EVENT',{detail:$detail}))"
        view.post { view.evaluateJavascript(script, null) }
    }

    /** What crossed the bridge in a `start` or an `update`: the call it is about, and its description. */
    private class Described(val callId: String, val spec: OngoingCallSpec)

    /**
     * `window.canariCall`. Called on a JavaScript binder thread; every method returns at once and
     * reports through [emit].
     */
    class JsInterface(private val context: Context) {
        @JavascriptInterface
        fun start(json: String) {
            val described = parse(json, "start") ?: return
            val callId = described.callId
            // ANDROID GRANTS A MICROPHONE SERVICE ONLY TO AN APP THAT IS ON SCREEN: started from the
            // background, `startForeground` with type `microphone` throws (API 34+) or the service
            // runs with no microphone capability (API 30-33). RESUMED is the stricter reading of "on
            // screen" (a paused activity can still be visible, under a permission dialog), chosen
            // because it is the one fact this process holds; a refusal for it is answered by the
            // next resume ([onActivityResumed]), so being strict costs a short delay, never the call.
            val admitted = offScreen.admit(callId, { MainActivity.isInForeground }) {
                Log.i(TAG, "start deferred: the app is not resumed - the next resume answers it")
                emit("failed", callId, "start: the app is not on screen", StartRefusal.OFF_SCREEN.code)
            }
            if (!admitted) return
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                refuse(callId, "start", "RECORD_AUDIO is not granted - a microphone service cannot start")
                return
            }
            // A PLAIN `startService`, never `startForegroundService`: the app is on screen (checked
            // above), so Android lets it start a service, and the service then enters the foreground
            // itself. A refused `startForeground` is then an exception the service logs and reports -
            // where after `startForegroundService` the system would count the service stopping
            // without `startForeground` as a crash of the whole process.
            try {
                context.startService(
                    CallForegroundService.intentFor(context, CallServiceCommand.Start(callId, described.spec)),
                )
                Log.i(TAG, "start sent (connected=${described.spec.connectedAtMs != null} speaker=${described.spec.speaker})")
            } catch (e: IllegalStateException) {
                refuse(callId, "start", "startService: ${e.message}")
            }
        }

        @JavascriptInterface
        fun update(json: String) {
            val described = parse(json, "update") ?: return
            deliver(CallServiceCommand.Update(described.callId, described.spec), "update")
        }

        @JavascriptInterface
        fun stop(callId: String, reason: String) {
            if (callId.isBlank()) {
                // The page always names its call; a blank one is a defect there, never "stop anything".
                Log.e(TAG, "stop refused: no call id (reason: $reason)")
                return
            }
            deliver(CallServiceCommand.Stop(callId, reason.ifBlank { "unspecified" }), "stop")
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
            deliver(CallServiceCommand.Stop(null, "a new page loaded - the call of the previous page is gone"), "stop")
        }

        /**
         * An update or a stop goes to a service that is ALREADY in the foreground, which Android lets
         * any app reach. With no service running and the app in the background, `startService` throws
         * `IllegalStateException`: the command was in flight when the service left (the notification's
         * hang-up, a refusal the page had not heard yet), so there is no call to act on - expected, and
         * said at INFO. With a service running the same throw is not expected, and is a WARN.
         */
        private fun deliver(command: CallServiceCommand, what: String) {
            try {
                context.startService(CallForegroundService.intentFor(context, command))
            } catch (e: IllegalStateException) {
                if (CallForegroundService.running) {
                    Log.w(TAG, "$what not delivered with the call service running: ${e.message}")
                } else {
                    Log.i(TAG, "$what not delivered: no call service runs and the app is in the background - a command of a call already over")
                }
            }
        }

        private fun parse(json: String, what: String): Described? {
            var callId: String? = null
            val result = try {
                val o = JSONObject(json)
                callId = o.optString("callId", "").ifBlank { null }
                if (callId == null) {
                    SpecResult.Refused("callId is missing")
                } else {
                    OngoingCallSpec.of(
                        title = o.optString("title", ""),
                        text = if (o.has("text")) o.getString("text") else null,
                        connectedAtMs = if (o.isNull("connectedAtMs")) null else o.getLong("connectedAtMs"),
                        speaker = if (o.has("speaker")) o.getBoolean("speaker") else null,
                        peerUserId = if (o.isNull("peerUserId")) null else o.getString("peerUserId"),
                        muted = if (o.has("muted")) o.getBoolean("muted") else null,
                        speakerChosen = if (o.has("speakerChosen")) o.getBoolean("speakerChosen") else null,
                    )
                }
            } catch (e: JSONException) {
                SpecResult.Refused("not the call description: ${e.message}")
            }
            return when (result) {
                is SpecResult.Valid -> Described(callId!!, result.spec)
                is SpecResult.Refused -> {
                    refuse(callId, what, result.reason)
                    null
                }
            }
        }

        private fun refuse(callId: String?, what: String, reason: String) {
            Log.e(TAG, "$what refused: $reason")
            emit("failed", callId, "$what: $reason", StartRefusal.REFUSED.code)
        }
    }
}
