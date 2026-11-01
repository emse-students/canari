package fr.emse.canari.call

/**
 * WHO RINGS AN INCOMING CALL, AND WHETHER IT MAY STILL RING (owner, 2026-11-01; review of #2877).
 *
 * A call can ring two ways on Android: the in-app player while the app is on screen
 * (`CallRingPlayer`), and the native CallStyle ring off screen
 * (`CanariFirebaseMessagingService.showIncomingCallNotification`). Both used to keep their own state,
 * and every defect the review found lived between them: a Home press that left a call silent, an
 * answer from the native ring that the page rang again on its return, a `call_ring` post landing
 * after the in-app ring had started and ringing it twice. This is the ONE place the state lives, and
 * every transition is taken under its lock, so two rings of one call cannot overlap by construction -
 * nothing reconciles them afterwards.
 *
 * - **One owner per call at a time**: [inApp] (the player) or [native] (a posted CallStyle ring).
 *   [startInApp] takes the call from a native ring (cancelled in the same critical section);
 *   [claimNative] refuses a call the player rings, so a late post cannot add a second ring.
 * - **A closed call never rings again** ([RingClosed]): answered on the native ring, ended (the
 *   caller hung up, a decline, the timeout, the page left the incoming state), or silenced by the
 *   power button. The page restarting the ring on its return, a stale incoming state after Doze, a
 *   late FCM redelivery - each is refused and logged. A SILENCED call is still a call: it keeps a
 *   SILENT native notification, so a locked phone can still answer it - as the system dialler does.
 * - **Expected refusals are said at INFO, overlaps at WARN.** Restarting a call that was answered or
 *   silenced, and a start off screen, are the design working; a native post for a call the app rings,
 *   an ENDED call asked to ring, or a post that fails are not.
 * - **Nothing slow runs under the lock**: [RingOutput.postNative] hands the post to a worker, which
 *   comes back through [claimNative]; the player's own calls are a `MediaPlayer` and a vibrator.
 *
 * No Android import is allowed in this package (the plain-JVM `android-tests` project compiles it):
 * the screen is asked through [onScreen], and Android is driven through [RingOutput].
 */

/** What the page knows of the ringing call - what either ring needs. */
data class RingFacts(
    val callId: String,
    val groupId: String,
    val callerId: String,
    val hasVideo: Boolean,
    val appSounds: Boolean,
)

/** Why a call may not ring any more on this phone. */
enum class RingClosed {
    /** Answered on the native ring ([CallRingAnswer.takeAnswer]): the page joins it. */
    ANSWERED,

    /** The caller hung up, it was declined, the ring window passed, or the page left the incoming state. */
    ENDED,

    /** The power button turned the screen off while it rang: the user's "not now", as the system ring takes it. */
    SILENCED,
}

/** What the sequencer has Android do. Every call is made UNDER the sequencer's lock: none may block. */
interface RingOutput {
    /** Plays the in-app ring of [ring] (sound and vibration, as the phone's state allows). */
    fun play(ring: RingFacts)

    /** Stops the in-app ring of [callId]: the sound, the vibration, and the audio focus it held. */
    fun silence(callId: String, reason: String)

    /** Takes the native ring of [callId] down (its notification and its call screen). */
    fun cancelNative(callId: String)

    /**
     * Posts the native ring of [ring] FROM A WORKER, which comes back through
     * [RingSequencer.claimNative]. [silent]: the call was silenced - the notification is posted with
     * no sound, no vibration and no full-screen screen, only to be answered from the lock screen.
     */
    fun postNative(ring: RingFacts, why: String, silent: Boolean)

    /** One log line; [accuse] is true for a refusal or a defect, false for an ordinary transition. */
    fun log(accuse: Boolean, message: String)
}

class RingSequencer(
    private val onScreen: () -> Boolean,
    private val output: RingOutput,
    /** How many closed calls are remembered: a ring window is 60 s, so a handful is already plenty. */
    private val closedCapacity: Int = 64,
) {
    private val lock = Any()
    private var inApp: RingFacts? = null
    private val native = LinkedHashSet<String>()
    private val closed = object : LinkedHashMap<String, RingClosed>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, RingClosed>?): Boolean =
            size > closedCapacity
    }

    /** The call the in-app player rings right now, or null. Read by any thread. */
    @Volatile
    var ringingInApp: String? = null
        private set

    /** Why [callId] may not ring any more, or null when it may. */
    fun closedReason(callId: String): RingClosed? = synchronized(lock) { closed[callId] }

    /** Whether a native ring of [callId] is up. */
    fun nativeRinging(callId: String): Boolean = synchronized(lock) { callId in native }

    /** How many native rings are up. */
    fun nativeCount(): Int = synchronized(lock) { native.size }

    /**
     * The page asks for the in-app ring of [r]. Refused for a closed call; refused off screen, where
     * the native ring is posted instead; a no-op for the call already ringing; otherwise a ring of
     * another call is silenced, a native ring of this one is taken down, and the player rings.
     */
    fun startInApp(r: RingFacts) = synchronized(lock) {
        closed[r.callId]?.let {
            // ANSWERED / SILENCED: the page's restart on the return those caused - expected. ENDED:
            // the page still shows a call this phone knows is over - a discrepancy, said at WARN.
            output.log(it == RingClosed.ENDED, "start refused: call=${short(r.callId)} is $it - it never rings again")
            return@synchronized
        }
        if (!onScreen()) {
            output.log(false, "start refused: call=${short(r.callId)} - the app is not on screen; the native ring rings it instead")
            output.postNative(r, "the page asked while off screen", silent = false)
            return@synchronized
        }
        if (inApp?.callId == r.callId) {
            output.log(false, "start: call=${short(r.callId)} already rings - nothing to do")
            return@synchronized
        }
        inApp?.let { silenceLocked(it.callId, "another call rings") }
        if (native.remove(r.callId)) output.cancelNative(r.callId)
        inApp = r
        ringingInApp = r.callId
        output.play(r)
    }

    /**
     * [callId] may not ring any more, for [why]: its in-app ring stops, its native ring is taken down
     * in the same critical section. Returns whether a native ring was up.
     */
    fun close(callId: String, why: RingClosed, reason: String): Boolean = synchronized(lock) {
        if (callId.isEmpty()) return@synchronized false
        closed[callId] = why
        if (inApp?.callId == callId) silenceLocked(callId, "$reason ($why)")
        val wasNative = native.remove(callId)
        if (wasNative) output.cancelNative(callId)
        output.log(false, "closed: call=${short(callId)} $why - $reason (native ring up=$wasNative)")
        wasNative
    }

    /**
     * The app left the screen with a call ringing in it. [screenOff] - the power button - silences
     * the RINGER, as it does the system's own: the call is [RingClosed.SILENCED], never rings again,
     * and keeps a SILENT native notification so the locked phone can still answer or decline it.
     * Otherwise (Home, another app) the native ring takes it over. Both are posted from a worker.
     */
    fun leftScreen(screenOff: Boolean) = synchronized(lock) {
        val r = inApp ?: return@synchronized
        if (screenOff) {
            silenceLocked(r.callId, "the screen went off - the power button silences the ring")
            closed[r.callId] = RingClosed.SILENCED
            output.postNative(r, "silenced by the power button - answerable from the lock screen", silent = true)
            return@synchronized
        }
        silenceLocked(r.callId, "the app left the screen - handed over to the native ring")
        output.postNative(r, "the app left the screen", silent = false)
    }

    /**
     * A native ring of [callId] is about to be posted: [post] runs UNDER THE LOCK when it may - the
     * claim and the notification are one critical section, so a [startInApp] cannot fall between
     * them. Refused, and logged, for a closed call, a call the player rings, or one already posted:
     * the answer is then null, otherwise what [post] returned. A [silent] post is the one a
     * [RingClosed.SILENCED] call is allowed: the notice of a call the user silenced, no ring.
     */
    fun <T> claimNative(callId: String, silent: Boolean = false, post: () -> T): T? = synchronized(lock) {
        val closedAs = closed[callId]
        if (closedAs != null && !(silent && closedAs == RingClosed.SILENCED)) {
            // A redelivery after an answer or a silence is expected; one after an END is late news.
            output.log(closedAs == RingClosed.ENDED, "native ring refused: call=${short(callId)} is $closedAs")
            return@synchronized null
        }
        if (inApp?.callId == callId) {
            output.log(true, "native ring REFUSED: call=${short(callId)} rings in the app - one ring per call")
            return@synchronized null
        }
        if (!native.add(callId)) {
            output.log(false, "native ring: call=${short(callId)} already rings - dedupe")
            return@synchronized null
        }
        try {
            post()
        } catch (e: RuntimeException) {
            // Nothing was posted: the claim goes with it, or a dedupe entry would refuse every later
            // post of a call that never rang.
            native.remove(callId)
            output.log(true, "native ring of call=${short(callId)} FAILED to post - claim released: ${e.javaClass.simpleName}: ${e.message}")
            throw e
        }
    }

    /** Runs [update] under the lock if the native ring of [callId] is still up (the caller's photo). */
    fun whileNativeRinging(callId: String, update: () -> Unit): Boolean = synchronized(lock) {
        if (callId !in native) return@synchronized false
        update()
        true
    }

    /**
     * The app came to the front: every native ring is taken down - the page rings what still rings.
     * The calls are NOT closed. [takeDown] runs under the lock, once per call.
     */
    fun clearNative(takeDown: (String) -> Unit) = synchronized(lock) {
        for (callId in native.toList()) takeDown(callId)
        native.clear()
    }

    private fun silenceLocked(callId: String, reason: String) {
        inApp = null
        ringingInApp = null
        output.silence(callId, reason)
    }

    private fun short(callId: String): String = callId.take(8)
}
