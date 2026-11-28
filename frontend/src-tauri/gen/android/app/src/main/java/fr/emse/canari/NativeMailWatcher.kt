package fr.emse.canari

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import fr.emse.canari.mail.NATIVE_MAIL_SOAP_URL
import fr.emse.canari.mail.NATIVE_MAX_SINGLE_NOTICES
import fr.emse.canari.mail.NATIVE_WAIT_TIMEOUT_SECONDS
import fr.emse.canari.mail.NativeCursor
import fr.emse.canari.mail.NativeInboxItem
import fr.emse.canari.mail.NativeMailFault
import fr.emse.canari.mail.NativeMailUnreadable
import fr.emse.canari.mail.NativeNoticeTexts
import fr.emse.canari.mail.NativeVaultRecord
import fr.emse.canari.mail.authTokenOf
import fr.emse.canari.mail.faultCodeOf
import fr.emse.canari.mail.inboxPageOf
import fr.emse.canari.mail.mailSummaryOf
import fr.emse.canari.mail.nativeAuthRequest
import fr.emse.canari.mail.nativeBaselineOf
import fr.emse.canari.mail.nativeCreateWaitSetRequest
import fr.emse.canari.mail.nativeCursorOf
import fr.emse.canari.mail.nativeCursorText
import fr.emse.canari.mail.nativeDeltaStep
import fr.emse.canari.mail.nativeDestroyWaitSetRequest
import fr.emse.canari.mail.nativeFaultOf
import fr.emse.canari.mail.nativeInboxPageRequest
import fr.emse.canari.mail.nativeNextHighest
import fr.emse.canari.mail.nativeNoticeOf
import fr.emse.canari.mail.nativeRetryDelayMs
import fr.emse.canari.mail.nativeWaitSetRequest
import fr.emse.canari.mail.soapEnvelope
import fr.emse.canari.mail.waitAnswerOf
import fr.emse.canari.mail.waitSetOf
import fr.emse.canari.mail.MailNoticeError
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import javax.net.ssl.HttpsURLConnection
import kotlin.concurrent.withLock

/**
 * THE NATIVE NEW-MAIL WATCHER (lot 4b, docs/wiki/mail-client-transport.md#as-built---lot-4b-the-native-android-watcher).
 *
 * The page's watcher (`mailWatcher.ts`), run with no page: [MailWatchService] starts it at boot, after
 * an update, after the system restarted a killed process, and when the page goes. It speaks to
 * [NATIVE_MAIL_SOAP_URL] directly, over the PLATFORM's TLS (`HttpsURLConnection`: the system trust
 * store, hostname verification) - no relay, as the apps' page does over its own socket.
 *
 * The SAME PROTOCOL, the rules pure in `NativeMailWatch.kt`: sign in from the sealed copy
 * ([MailWatchVault]); create the wait set FIRST; read the delta against the SAME cursor file the page
 * uses (`mail_watch/cursor_<id>.json`, atomic writes) and write it BEFORE notifying; wait from the wait
 * set's `seq`; a change reads the delta again. The cursor proves "never twice" across the page and the
 * native run alike, because only ONE of them runs at a time: the page CLAIMS the watch before its own
 * run starts ([stopAndJoin], the bridge's `claim`), and this run is joined - dead - before the claim
 * is answered.
 *
 * Its timers bound a RATE or a transport, never decide: the ladder ([nativeRetryDelayMs]) paces
 * retries and ends early when a network comes back; the read timeout only cuts a connection the
 * server stopped answering (a transport failure, retried). Neither question reads a clock.
 *
 * Before each cursor write and each notice the run checks that its sealed copy is still there
 * ([MailWatchVault.stillArmed]): every forget path erases it, so an erased copy is a run that ends
 * without another word to the server.
 */
object NativeMailWatcher {
    private const val TAG = "NativeMailWatcher"

    /** A wait asks the server for [NATIVE_WAIT_TIMEOUT_SECONDS]; a read silent this long is a dead connection. */
    private const val READ_TIMEOUT_MS = (NATIVE_WAIT_TIMEOUT_SECONDS + 60) * 1000
    private const val CONNECT_TIMEOUT_MS = 15_000

    /** Why a run ended by itself: [MailWatchService] leaves the foreground on it. */
    fun interface Ended {
        fun onEnded(reason: String)
    }

    /** What [checkOnce] answers its caller. */
    enum class CheckOutcome {
        /** The delta was read and notified (perhaps nothing new). */
        DONE,

        /** Nothing is sealed (the switch off, "remember" unticked, or a forget path erased it). */
        NOTHING_SEALED,

        /** A watcher already watches - the page's or the persistent native run: it notifies itself. */
        WATCHING,

        /** Another check runs right now: this one would read the same delta. */
        BUSY,

        /** The server refused the sealed password: the copy is erased. */
        REFUSED,

        /** A transport or server failure: the next push or open reads the same delta. */
        FAILED,
    }

    private val lock = ReentrantLock()

    /** Held for the whole of one [checkOnce], so a page claim can wait for it to end. */
    private val checkLock = ReentrantLock()

    /** The page claimed the watch and has not gone since: a push check leaves it to the page. */
    @Volatile private var pageHolds = false
    private val wake = lock.newCondition()
    private var thread: Thread? = null
    @Volatile private var stopping = false
    @Volatile private var connection: HttpURLConnection? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    val running: Boolean get() = thread?.isAlive == true

    /** Starts the run for the armed copy, unless one runs. Called on the service's thread. */
    fun start(context: Context, ended: Ended) {
        val app = context.applicationContext
        lock.withLock {
            if (thread?.isAlive == true) {
                Log.i(TAG, "start: a native run is already there")
                return
            }
            stopping = false
            pageHolds = false
            // A push check in flight ends first ([checkOnce] holds checkLock): one writer of the cursor.
            thread = Thread({
                checkLock.withLock { }
                run(app, ended)
            }, "canari-mail-native").also { it.start() }
        }
        registerNetwork(app)
        Log.i(TAG, "native run started")
    }

    /**
     * Stops the run and WAITS for its thread to end: on return, it writes no cursor and posts no notice
     * any more. The open connection is cut so a wait in flight ends at once. Never on the main thread.
     */
    fun stopAndJoin(context: Context, why: String, forPage: Boolean = false) {
        val t = lock.withLock {
            if (forPage) pageHolds = true
            stopping = true
            wake.signalAll()
            thread
        }
        connection?.disconnect()
        if (t != null && t.isAlive) {
            Log.i(TAG, "stopping the native run ($why)")
            t.join()
        }
        // A push check in flight ends too (it reads `stopping`), and is waited for: on return,
        // nothing native writes the cursor or posts.
        checkLock.withLock { }
        unregisterNetwork(context.applicationContext)
    }

    /** The page that claimed the watch is gone (the activity destroyed, a new document). */
    fun pageGone() {
        if (pageHolds) Log.d(TAG, "the page that held the watch is gone")
        pageHolds = false
    }

    /**
     * ONE delta check, then notify - THE ENTRY POINT OF THE PUSH PATH (mail lot 5: the FCM handler
     * calls it on an empty data push that says the mailbox changed). The same sealed copy, the same
     * cursor file, the same notices as the persistent run, and the same rule of one watcher at a time:
     * it does nothing while the page or the persistent native run watches (they notify by themselves),
     * and a page claim waits for it to end ([stopAndJoin]). Blocking - call it from a worker thread,
     * never the main thread. The persistent watch stays the user's separate choice; this needs no
     * foreground service.
     */
    fun checkOnce(context: Context): CheckOutcome {
        val app = context.applicationContext
        if (!checkLock.tryLock()) {
            Log.i(TAG, "check: another check runs - nothing more to read")
            return CheckOutcome.BUSY
        }
        try {
            lock.withLock {
                if (thread?.isAlive == true || pageHolds) {
                    Log.i(TAG, "check: a watcher already watches - left to it")
                    return CheckOutcome.WATCHING
                }
                stopping = false
            }
            val armed = MailWatchVault.armed(app)
            val record = armed?.let { MailWatchVault.open(app, it) }
            if (armed == null || record == null) {
                Log.i(TAG, "check: nothing sealed - no check")
                return CheckOutcome.NOTHING_SEALED
            }
            return try {
                val token = authToken(record)
                readAndNotify(app, armed.userId, record, token)
                Log.i(TAG, "check: done")
                CheckOutcome.DONE
            } catch (f: Fault) {
                if (f.kind == NativeMailFault.BAD_CREDENTIALS) {
                    Log.w(TAG, "check: the server refuses the sealed password (${f.code}) - erased")
                    MailWatchVault.eraseRefused(app, armed.userId)
                    CheckOutcome.REFUSED
                } else {
                    Log.w(TAG, "check: fault ${f.code}")
                    CheckOutcome.FAILED
                }
            } catch (_: Stopped) {
                Log.i(TAG, "check: the page claimed the watch meanwhile - it reads the delta itself")
                CheckOutcome.WATCHING
            } catch (_: Disarmed) {
                Log.i(TAG, "check: the sealed copy was erased meanwhile")
                CheckOutcome.NOTHING_SEALED
            } catch (e: IOException) {
                if (stopping) return CheckOutcome.WATCHING
                Log.w(TAG, "check: transport failure (${e.javaClass.simpleName})")
                CheckOutcome.FAILED
            } catch (e: NativeMailUnreadable) {
                Log.e(TAG, "check: ${e.message}") // log-safe: names the answer's missing field, never its content
                CheckOutcome.FAILED
            }
        } finally {
            checkLock.unlock()
        }
    }

    /** The page claims the watch, or the service leaves: stop without blocking the caller. */
    fun stopAsync(context: Context, why: String) {
        if (!running) return
        Thread({ stopAndJoin(context, why) }, "canari-mail-native-stop").start()
    }

    private class Stopped : Exception()

    /** A forget path erased the sealed copy while the run was reading: it ends, and says so. */
    private class Disarmed : Exception()

    private class Fault(val kind: NativeMailFault, val code: String) : Exception("fault $code")

    private fun run(context: Context, ended: Ended) {
        val armed = MailWatchVault.armed(context)
        val record = armed?.let { MailWatchVault.open(context, it) }
        if (armed == null || record == null) {
            Log.i(TAG, "nothing sealed to run with - the run ends")
            ended.onEnded("nothing sealed")
            return
        }
        val userId = armed.userId
        var token: String? = null
        var failures = 0
        var healthy = false
        var waitSet: String? = null
        val endReason: String = try {
            while (true) {
                if (stopping) throw Stopped()
                try {
                    if (token == null) token = authToken(record)
                    val created = waitSetOf(call(nativeCreateWaitSetRequest(record.account), token))
                    waitSet = created.id
                    readAndNotify(context, userId, record, token)
                    var seq = created.seq
                    while (true) {
                        val answer = waitAnswerOf(call(nativeWaitSetRequest(created.id, seq), token))
                        if (answer.canceled) throw Fault(NativeMailFault.WAIT_LOST, "canceled")
                        healthy = true
                        failures = 0
                        seq = answer.seq
                        if (answer.changed) {
                            Log.d(TAG, "the mailbox changed - reading the delta")
                            readAndNotify(context, userId, record, token)
                        }
                    }
                } catch (f: Fault) {
                    when (f.kind) {
                        NativeMailFault.BAD_CREDENTIALS -> {
                            Log.w(TAG, "the server refuses the sealed password (${f.code}) - erased, the run ends")
                            MailWatchVault.eraseRefused(context, userId)
                            ended.onEnded("the password was refused")
                            return
                        }
                        NativeMailFault.SESSION_EXPIRED -> {
                            Log.i(TAG, "the session lapsed (${f.code}) - signing in again")
                            token = null
                        }
                        NativeMailFault.WAIT_LOST -> {
                            waitSet = null
                            if (healthy) {
                                Log.i(TAG, "the wait set lapsed after a normal wait - created again")
                                healthy = false
                            } else {
                                failures++
                                Log.w(TAG, "the wait set was lost before any wait blocked (${f.code}) - retry $failures")
                                pause(nativeRetryDelayMs(failures))
                            }
                        }
                        NativeMailFault.OTHER -> {
                            failures++
                            Log.w(TAG, "fault ${f.code} - retry $failures")
                            pause(nativeRetryDelayMs(failures))
                        }
                    }
                } catch (e: IOException) {
                    if (stopping) throw Stopped()
                    failures++
                    healthy = false
                    Log.w(TAG, "transport failure (${e.javaClass.simpleName}) - retry $failures")
                    pause(nativeRetryDelayMs(failures))
                } catch (e: NativeMailUnreadable) {
                    failures++
                    Log.e(TAG, "${e.message} - retry $failures") // log-safe: names the answer's missing field, never its content
                    pause(nativeRetryDelayMs(failures))
                }
            }
            @Suppress("UNREACHABLE_CODE")
            "unreachable"
        } catch (_: Stopped) {
            "stopped"
        } catch (_: Disarmed) {
            Log.i(TAG, "the sealed copy was erased by a forget path - the run ends")
            ended.onEnded("the sealed copy was erased")
            "disarmed"
        } catch (e: Exception) {
            Log.e(TAG, "the native run failed: ${e.javaClass.simpleName}")
            ended.onEnded("failed")
            "failed"
        }
        val ws = waitSet
        val t = token
        if (ws != null && t != null) release(ws, t)
        Log.i(TAG, "native run ended: $endReason") // log-safe: one of four constant words
    }

    /** Signs in from the sealed copy: the page's `AuthRequest`. */
    private fun authToken(record: NativeVaultRecord): String {
        Log.d(TAG, "signing in from the sealed copy")
        return authTokenOf(call(nativeAuthRequest(record.account, record.password), null))
    }

    /** Releases the wait set best effort, on a fresh connection (the run's may have been cut by the stop). */
    private fun release(waitSet: String, token: String) {
        try {
            post(soapEnvelope(nativeDestroyWaitSetRequest(waitSet), token), allowWhileStopping = true)
            Log.d(TAG, "wait set released")
        } catch (e: Exception) {
            Log.i(TAG, "the wait set was not released (${e.javaClass.simpleName}) - it lapses by itself")
        }
    }

    /** One SOAP call; a fault becomes a typed [Fault]. */
    private fun call(body: JSONObject, token: String?): JSONObject {
        val answer = post(soapEnvelope(body, token), allowWhileStopping = false)
        val code = faultCodeOf(answer)
        if (code != null) throw Fault(nativeFaultOf(code), code)
        return answer
    }

    private fun post(envelope: JSONObject, allowWhileStopping: Boolean): JSONObject {
        if (stopping && !allowWhileStopping) throw IOException("stopping")
        val conn = URL(NATIVE_MAIL_SOAP_URL).openConnection() as HttpsURLConnection
        if (!allowWhileStopping) connection = conn
        try {
            // Re-read AFTER publishing the connection: a stop either saw it (and cut it) or is seen here.
            if (stopping && !allowWhileStopping) throw IOException("stopping")
            conn.requestMethod = "POST"
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.doOutput = true
            conn.useCaches = false
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.setRequestProperty("Accept", "application/json")
            conn.outputStream.use { it.write(envelope.toString().toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
                ?: throw IOException("HTTP $status with no body")
            val text = stream.use { String(it.readBytes(), Charsets.UTF_8) }
            return try {
                JSONObject(text)
            } catch (_: Exception) {
                throw NativeMailUnreadable("HTTP $status without a SOAP envelope")
            }
        } finally {
            if (!allowWhileStopping) connection = null
            conn.disconnect()
        }
    }

    /** The cursor file the page's `mail_watch_cursor_read` reads: `mail_watch/cursor_<id>.json`. */
    private fun cursorFile(context: Context, userId: String) =
        File(File(MlsContextLoader.tauriDataDir(context), "mail_watch"), "cursor_$userId.json")

    /** Atomic, as `write_cursor` in Rust: a sibling file renamed over it. */
    private fun writeCursor(context: Context, userId: String, cursor: NativeCursor): Boolean {
        val f = cursorFile(context, userId)
        return try {
            f.parentFile?.mkdirs()
            val tmp = File(f.parentFile, "${f.name}.tmp")
            tmp.writeText(nativeCursorText(cursor))
            tmp.renameTo(f).also { if (!it) Log.e(TAG, "the cursor was not renamed into place") }
        } catch (e: Exception) {
            Log.e(TAG, "the cursor was not written: ${e.javaClass.simpleName}")
            false
        }
    }

    /** The run may still act: not stopping ([Stopped]), and its sealed copy not erased by a forget path ([Disarmed]). */
    private fun ensureCurrent(context: Context, userId: String) {
        if (stopping) throw Stopped()
        if (!MailWatchVault.stillArmed(context, userId)) throw Disarmed()
    }

    /** The page's `readNewInboxMail` + `postMailNotices`. */
    private fun readAndNotify(context: Context, userId: String, record: NativeVaultRecord, token: String) {
        val raw = cursorFile(context, userId).takeIf { it.exists() }?.readText()
        val cursor = nativeCursorOf(raw, record.account)
        if (cursor == null) {
            val top = nativeBaselineOf(inboxPageOf(call(nativeInboxPageRequest(null), token)))
            ensureCurrent(context, userId)
            val written = writeCursor(context, userId, NativeCursor(record.account.lowercase(), top))
            Log.i(TAG, "baseline taken at item $top (written: $written) - nothing notified")
            return
        }
        val above = mutableListOf<NativeInboxItem>()
        var after: String? = null
        while (true) {
            val step = nativeDeltaStep(inboxPageOf(call(nativeInboxPageRequest(after), token)), cursor)
            above += step.above
            after = step.nextAfter ?: break
        }
        val highest = nativeNextHighest(cursor, above)
        ensureCurrent(context, userId)
        if (highest != cursor.highest && !writeCursor(context, userId, cursor.copy(highest = highest))) {
            Log.e(TAG, "the cursor was not written - nothing notified, the next read retries")
            return
        }
        val fresh = above.filter { it.unread }
        Log.d(TAG, "delta: ${above.size} above the cursor, ${fresh.size} unread, cursor ${cursor.highest} -> $highest") // log-safe: counts and Zimbra item ids, never content
        if (fresh.isEmpty()) return
        ensureCurrent(context, userId)
        notify(context, fresh)
    }

    private fun notify(context: Context, fresh: List<NativeInboxItem>) {
        val res = appLocaleContext(context)
        val texts = NativeNoticeTexts(
            res.getString(R.string.mail_sender_unknown),
            res.getString(R.string.mail_no_subject),
            res.getString(R.string.mail_notif_public_title),
        )
        if (fresh.size > NATIVE_MAX_SINGLE_NOTICES) {
            Log.i(TAG, "${fresh.size} new mails - one summary notice")
            mailSummaryOf(
                fresh.size.toLong(),
                res.resources.getQuantityString(R.plurals.mail_notif_summary_title, fresh.size, fresh.size),
                res.getString(R.string.mail_notif_summary_body),
                texts.publicTitle,
                "fr.emse.canari://mail",
            ).fold(onSuccess = { MailWatchBridge.postSummary(context, it) }, onFailure = { refused(it) })
            return
        }
        Log.i(TAG, "${fresh.size} new mail notification(s) to post")
        for (item in fresh) {
            val notice = nativeNoticeOf(item, texts) ?: continue
            notice.fold(onSuccess = { MailWatchBridge.post(context, it) }, onFailure = { refused(it) })
        }
    }

    private fun refused(error: Throwable) {
        val why = (error as? MailNoticeError)?.refusal?.name ?: error.javaClass.simpleName
        Log.e(TAG, "notice refused: $why") // log-safe: an enum constant or a class name, never the notice's text
    }

    /** The ladder's pause: ends at [ms], at a network coming back, or at once on a stop. */
    private fun pause(ms: Long) {
        lock.withLock {
            if (stopping) throw Stopped()
            wake.await(ms, TimeUnit.MILLISECONDS)
            if (stopping) throw Stopped()
        }
    }

    private fun registerNetwork(context: Context) {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        lock.withLock {
            if (networkCallback != null) return
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    lock.withLock { wake.signalAll() }
                }
            }
            try {
                cm.registerDefaultNetworkCallback(cb)
                networkCallback = cb
            } catch (e: Exception) {
                Log.e(TAG, "network callback not registered: ${e.javaClass.simpleName}")
            }
        }
    }

    private fun unregisterNetwork(context: Context) {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        val cb = lock.withLock { networkCallback.also { networkCallback = null } } ?: return
        try {
            cm.unregisterNetworkCallback(cb)
        } catch (e: Exception) {
            Log.i(TAG, "network callback not unregistered: ${e.javaClass.simpleName}")
        }
    }
}
