package fr.emse.canari.mail

import org.json.JSONObject
import java.io.IOException

/**
 * THE NATIVE WATCHER'S RUN, WITH NOTHING FROM ANDROID IN IT (lot 4b,
 * docs/wiki/mail-client-transport.md#as-built---lot-4b-the-native-android-watcher).
 *
 * The whole loop of the page's `mailWatcher.ts`, over [NativeMailPorts]: what talks to the server,
 * opens the sealed copy, reads and writes the cursor, posts the notices and pauses is the Android
 * adapter's (`NativeMailWatcher.kt`); WHEN each happens, and what every answer means, is here - so
 * `NativeMailRunTest` drives the real loop on a JVM against a fake server: an erased copy ends a run
 * after the next wait, a refused or closed account erases, a lapsed session is re-signed-in only after
 * a normal wait, a page that does not advance ends the delta.
 */

/** Why a run ended. Every value but [STOPPED] is the run ending BY ITSELF (the service leaves). */
enum class NativeRunEnd {
    /** Stopped from outside: a page claim, a stop, a forget. */
    STOPPED,

    /** Nothing sealed when it started (the switch off, "remember" unticked). */
    NOTHING_SEALED,

    /** A forget path erased the sealed copy while it ran. */
    DISARMED,

    /** The server refused the sealed password: the copy is erased. */
    REFUSED,

    /** The school closed the account (`account.NO_SUCH_ACCOUNT` at sign-in, D8): copy and cursor erased. */
    ACCOUNT_CLOSED,

    /** The account is inactive (`account.ACCOUNT_INACTIVE`): nothing erased, the run ends. */
    UNAVAILABLE,
}

/** What one push check answers (`NativeMailWatcher.checkOnce`). */
enum class NativeCheckEnd { DONE, STOPPED, NOTHING_SEALED, DISARMED, REFUSED, ACCOUNT_CLOSED, UNAVAILABLE, FAILED }

/** Why the run erases its sealed copy itself. */
enum class NativeEraseReason {
    /** The password is refused: the copy alone goes (the page will ask for it). */
    REFUSED,

    /** The account is gone (D8): the copy AND the cursor go. */
    ACCOUNT_CLOSED,
}

/** The run was stopped from outside: thrown by [NativeMailPorts] at its next step. */
class NativeStopped : Exception()

/** What the run needs from the platform. Each call may throw [NativeStopped] once a stop is asked. */
interface NativeMailPorts {
    /** One SOAP call; the ENVELOPE answered (a fault included). [IOException] on a transport failure. */
    fun call(body: JSONObject, token: String?): JSONObject

    /**
     * The same, on a fresh SHORT-timeout connection that a stop does not refuse: the wait set's
     * release only - a stop waits for it, so it must end in seconds, never in a wait's minutes.
     */
    fun callAfterStop(body: JSONObject, token: String): JSONObject

    /** Whether a stopped run releases its wait set: not on a forget (the copy is gone, leave at once). */
    fun releaseAllowed(): Boolean

    /** A MONOTONIC clock in ms: only to bound the rate of waits the server answers empty at once. */
    fun elapsedMs(): Long

    /** Opens the sealed copy NOW (at each sign-in: the password is never held for the run), or `null`. */
    fun openVault(): NativeVaultRecord?

    /** Whether the sealed copy is still there: every forget path erases it. */
    fun stillArmed(): Boolean

    fun eraseVault(reason: NativeEraseReason)

    fun readCursor(): String?

    fun writeCursor(text: String): Boolean

    fun notify(fresh: List<NativeInboxItem>)

    /** The ladder's pause: ends at [ms], when a network comes back, or by throwing on a stop. */
    fun pause(ms: Long)

    /** Throws [NativeStopped] when a stop was asked. */
    fun checkStopped()

    fun log(line: String)
}

/** A fault, classified at the throw. */
private class NativeFault(val kind: NativeMailFault, val code: String) : Exception("fault $code")

/** The copy was erased while the run read. */
private class NativeDisarmed : Exception()

/** The run ends by itself with [end]. */
private class NativeEnds(val end: NativeRunEnd) : Exception()

/**
 * A wait the server answers EMPTY sooner than this did not block: counted as a failure on the
 * ladder, so a server answering at once cannot drive a tight loop. A RATE bound only - a change is
 * never decided by it (a wait that reports a change is read whatever its duration).
 */
const val NATIVE_FAST_EMPTY_WAIT_MS = 30_000L

/** One native run (a persistent watch, or one check) over [ports]. */
class NativeMailRun(private val ports: NativeMailPorts) {
    private var token: String? = null
    private var account: String? = null

    /** A wait completed normally since the last sign-in: only then is a lapsed session re-signed-in at once. */
    private var waitedSinceSignIn = false

    /** The persistent watch: until stopped, or until it ends by itself. */
    fun watch(): NativeRunEnd {
        var failures = 0
        var healthy = false
        var waitSet: String? = null
        try {
            while (true) {
                ports.checkStopped()
                try {
                    signIn()
                    val created = waitSetOf(call(nativeCreateWaitSetRequest(account!!)))
                    waitSet = created.id
                    readAndNotify()
                    var seq = created.seq
                    while (true) {
                        val asked = ports.elapsedMs()
                        val answer = waitAnswerOf(call(nativeWaitSetRequest(created.id, seq)))
                        // After EVERY wait: a copy erased while the run waited ends it now, with no
                        // other word to the server - not at the next change.
                        ensureArmed()
                        if (answer.canceled) throw NativeFault(NativeMailFault.WAIT_LOST, "canceled")
                        if (!answer.changed && ports.elapsedMs() - asked < NATIVE_FAST_EMPTY_WAIT_MS) {
                            failures++
                            ports.log("a wait was answered empty without blocking - retry $failures")
                            seq = answer.seq
                            ports.pause(nativeRetryDelayMs(failures))
                            continue
                        }
                        healthy = true
                        waitedSinceSignIn = true
                        failures = 0
                        seq = answer.seq
                        if (answer.changed) {
                            ports.log("the mailbox changed - reading the delta")
                            readAndNotify()
                        }
                    }
                } catch (f: NativeFault) {
                    when (f.kind) {
                        NativeMailFault.SESSION_EXPIRED -> {
                            token = null
                            if (waitedSinceSignIn) {
                                ports.log("the session lapsed (${f.code}) - signing in again")
                            } else {
                                // A session refused again before any wait completed is a FAILURE: signing
                                // in in a loop is how an account gets locked.
                                failures++
                                ports.log("the session lapsed again before any wait (${f.code}) - retry $failures")
                                ports.pause(nativeRetryDelayMs(failures))
                            }
                        }
                        NativeMailFault.WAIT_LOST -> {
                            waitSet = null
                            if (healthy) {
                                ports.log("the wait set lapsed after a normal wait - created again")
                                healthy = false
                            } else {
                                failures++
                                ports.log("the wait set was lost before any wait blocked (${f.code}) - retry $failures")
                                ports.pause(nativeRetryDelayMs(failures))
                            }
                        }
                        else -> {
                            failures++
                            ports.log("fault ${f.code} - retry $failures")
                            ports.pause(nativeRetryDelayMs(failures))
                        }
                    }
                } catch (e: IOException) {
                    ports.checkStopped()
                    // The connection the wait set was created on is gone: the next turn creates
                    // another, and a stop does not try to release this one.
                    waitSet = null
                    failures++
                    healthy = false
                    ports.log("transport failure (${e.javaClass.simpleName}) - retry $failures")
                    ports.pause(nativeRetryDelayMs(failures))
                } catch (e: NativeMailUnreadable) {
                    failures++
                    ports.log("${e.message} - retry $failures")
                    ports.pause(nativeRetryDelayMs(failures))
                }
            }
        } catch (_: NativeStopped) {
            release(waitSet)
            return NativeRunEnd.STOPPED
        } catch (_: NativeDisarmed) {
            ports.log("the sealed copy was erased - the run ends")
            return NativeRunEnd.DISARMED
        } catch (e: NativeEnds) {
            return e.end
        }
    }

    /** ONE delta check and notify (the push path, mail lot 5). */
    fun checkOnce(): NativeCheckEnd = try {
        ports.checkStopped()
        signIn()
        readAndNotify()
        NativeCheckEnd.DONE
    } catch (_: NativeStopped) {
        NativeCheckEnd.STOPPED
    } catch (_: NativeDisarmed) {
        NativeCheckEnd.DISARMED
    } catch (e: NativeEnds) {
        NativeCheckEnd.valueOf(e.end.name)
    } catch (f: NativeFault) {
        ports.log("check: fault ${f.code}")
        NativeCheckEnd.FAILED
    } catch (e: IOException) {
        ports.log("check: transport failure (${e.javaClass.simpleName})")
        NativeCheckEnd.FAILED
    } catch (e: NativeMailUnreadable) {
        ports.log("check: ${e.message}")
        NativeCheckEnd.FAILED
    }

    /** Signs in when no token is held: the copy is opened NOW, and an account fault at sign-in decides. */
    private fun signIn() {
        if (token != null) return
        val record = ports.openVault() ?: throw NativeEnds(if (account == null) NativeRunEnd.NOTHING_SEALED else NativeRunEnd.DISARMED)
        ports.log("signing in from the sealed copy")
        val envelope = ports.call(nativeAuthRequest(record.account, record.password), null)
        val code = faultCodeOf(envelope)
        if (code != null) {
            when (val kind = nativeFaultOf(code, NativeFaultOrigin.AUTH)) {
                NativeMailFault.BAD_CREDENTIALS -> {
                    ports.log("the server refuses the sealed password ($code) - erased")
                    ports.eraseVault(NativeEraseReason.REFUSED)
                    throw NativeEnds(NativeRunEnd.REFUSED)
                }
                NativeMailFault.ACCOUNT_CLOSED -> {
                    ports.log("the account is closed ($code) - the copy and the cursor are erased")
                    ports.eraseVault(NativeEraseReason.ACCOUNT_CLOSED)
                    throw NativeEnds(NativeRunEnd.ACCOUNT_CLOSED)
                }
                NativeMailFault.UNAVAILABLE -> {
                    ports.log("the account is unavailable ($code) - the run ends, nothing erased")
                    throw NativeEnds(NativeRunEnd.UNAVAILABLE)
                }
                else -> throw NativeFault(kind, code)
            }
        }
        token = authTokenOf(envelope)
        account = record.account
        waitedSinceSignIn = false
    }

    /** One call with the session token; a fault becomes a typed [NativeFault]. */
    private fun call(body: JSONObject): JSONObject {
        val envelope = ports.call(body, token)
        val code = faultCodeOf(envelope)
        if (code != null) throw NativeFault(nativeFaultOf(code, NativeFaultOrigin.CALL), code)
        return envelope
    }

    private fun ensureArmed() {
        ports.checkStopped()
        if (!ports.stillArmed()) throw NativeDisarmed()
    }

    /** The page's `readNewInboxMail` + `postMailNotices`, on the shared cursor. */
    private fun readAndNotify() {
        val mailbox = account!!
        val cursor = nativeCursorOf(ports.readCursor(), mailbox)
        if (cursor == null) {
            val top = nativeBaselineOf(inboxPageOf(call(nativeInboxPageRequest(null))))
            ensureArmed()
            val written = ports.writeCursor(nativeCursorText(NativeCursor(nativeAddress(mailbox), top)))
            ports.log("baseline taken at item $top (written: $written) - nothing notified")
            return
        }
        val above = mutableListOf<NativeInboxItem>()
        var after: String? = null
        val seen = mutableSetOf<String>()
        while (true) {
            val step = nativeDeltaStep(inboxPageOf(call(nativeInboxPageRequest(after))), cursor)
            above += step.above
            val next = step.nextAfter ?: break
            if (!seen.add(next)) {
                // A page cursor met before in this read would be asked for forever (a repeat, or a
                // cycle): the read stops here, and says so.
                ports.log("ERROR: an inbox page did not advance - the read stops there")
                break
            }
            after = next
        }
        val highest = nativeNextHighest(cursor, above)
        ensureArmed()
        if (highest != cursor.highest && !ports.writeCursor(nativeCursorText(cursor.copy(highest = highest)))) {
            ports.log("ERROR: the cursor was not written - nothing notified, the next read retries")
            return
        }
        val fresh = above.filter { it.unread }
        ports.log("delta: ${above.size} above the cursor, ${fresh.size} unread, cursor ${cursor.highest} -> $highest")
        if (fresh.isEmpty()) return
        ensureArmed()
        ports.notify(fresh)
    }

    /** Releases the wait set best effort after a stop (short timeouts), never after a forget. */
    private fun release(waitSet: String?) {
        val t = token ?: return
        if (waitSet == null) return
        if (!ports.releaseAllowed()) {
            ports.log("forgotten - the wait set is left to lapse by itself")
            return
        }
        try {
            ports.callAfterStop(nativeDestroyWaitSetRequest(waitSet), t)
            ports.log("wait set released")
        } catch (e: Exception) {
            ports.log("the wait set was not released (${e.javaClass.simpleName}) - it lapses by itself")
        }
    }
}
