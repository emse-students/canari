package fr.emse.canari

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import fr.emse.canari.mail.MailNoticeError
import fr.emse.canari.mail.MailWatchCommand
import fr.emse.canari.mail.NATIVE_MAIL_SOAP_URL
import fr.emse.canari.mail.NATIVE_MAX_SINGLE_NOTICES
import fr.emse.canari.mail.NATIVE_WAIT_TIMEOUT_SECONDS
import fr.emse.canari.mail.NativeCheckEnd
import fr.emse.canari.mail.NativeEraseReason
import fr.emse.canari.mail.NativeInboxItem
import fr.emse.canari.mail.NativeMailPorts
import fr.emse.canari.mail.NativeMailRun
import fr.emse.canari.mail.NativeMailUnreadable
import fr.emse.canari.mail.NativeNoticeTexts
import fr.emse.canari.mail.NativeRunEnd
import fr.emse.canari.mail.NativeStopped
import fr.emse.canari.mail.NativeVaultRecord
import fr.emse.canari.mail.mailSummaryOf
import fr.emse.canari.mail.nativeNoticeOf
import fr.emse.canari.mail.soapEnvelope
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URL
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import javax.net.ssl.HttpsURLConnection
import kotlin.concurrent.withLock

/**
 * THE NATIVE NEW-MAIL WATCHER, ANDROID'S SIDE (lot 4b, docs/wiki/mail-client-transport.md#as-built---lot-4b-the-native-android-watcher).
 *
 * The page's watcher (`mailWatcher.ts`), run with no page: [MailWatchService] starts it at boot, after
 * an update, after the system restarted a killed process, and when the page goes. WHAT the run does
 * is pure and tested on a JVM ([NativeMailRun], `NativeMailRunTest`); this object is its ports: it
 * talks to [NATIVE_MAIL_SOAP_URL] over the PLATFORM's TLS (`HttpsURLConnection`: the system trust
 * store, hostname verification, NO redirect followed), opens the sealed copy ([MailWatchVault]) at
 * each sign-in, reads and writes the SAME cursor file the page uses (`mail_watch/cursor_<id>.json`,
 * atomic), and posts the notices through [MailWatchBridge].
 *
 * ONE WRITER OF THE CURSOR AT A TIME. Each run - the persistent watch, or one push check - is its own
 * [Run] handle, stopped by the handle captured at the call (a stop never lands on a run started after
 * it). The page CLAIMS the watch before its own run starts ([stopAndJoin], the bridge's `claim`) and is
 * answered only once every native run is joined; a push check does nothing while a watcher runs, and
 * a run starting waits for a check in flight.
 *
 * FORGETTING IS ONE OP ([forget]): the sealed copy erased and every native run stopped and joined,
 * together, then the service told - the page's forget paths, and (mail lot 5) a remote `mail-forget`
 * push from the FCM service.
 */
object NativeMailWatcher {
    private const val TAG = "NativeMailWatcher"

    /** A wait asks the server for [NATIVE_WAIT_TIMEOUT_SECONDS]; a read silent this long is a dead connection. */
    private const val READ_TIMEOUT_MS = (NATIVE_WAIT_TIMEOUT_SECONDS + 60) * 1000
    private const val CONNECT_TIMEOUT_MS = 15_000

    /** Why a run ended by itself: [MailWatchService] leaves the foreground on it. */
    fun interface Ended {
        fun onEnded(run: Long, reason: String)
    }

    /** What [checkOnce] answers its caller (the push path, mail lot 5). */
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

        /** The school closed the account: the copy and the cursor are erased. */
        ACCOUNT_CLOSED,

        /** The account is inactive: nothing erased. */
        UNAVAILABLE,

        /** A transport or server failure: the next push or open reads the same delta. */
        FAILED,
    }

    /** One run's handle: its own stop flag, its open connection and its pause. */
    private class Run(val id: Long, val thread: Thread?) {
        val lock = ReentrantLock()
        val wake = lock.newCondition()!!
        @Volatile var stopping = false
        var connection: HttpsURLConnection? = null

        /** Stops this run: the flag, the pause woken, the connection cut - under the lock [post] publishes under. */
        fun stop() = lock.withLock {
            stopping = true
            wake.signalAll()
            connection?.disconnect()
        }
    }

    private val lock = ReentrantLock()
    private var watchRun: Run? = null
    private var checkRun: Run? = null
    private var lastRunId = 0L

    /** Held for the whole of one [checkOnce], so a claim, a forget or a starting run waits for it. */
    private val checkLock = ReentrantLock()

    /** The page claimed the watch and has not let it go: a push check leaves it to the page. */
    @Volatile private var pageHolds = false

    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    val running: Boolean get() = lock.withLock { watchRun?.let { !it.stopping && it.thread?.isAlive == true } == true }

    /**
     * Starts the persistent run for the armed copy, unless one runs, and returns its id: [ended]
     * hands it back, so the service tells the end of THIS run from an earlier one's.
     */
    fun start(context: Context, ended: Ended): Long {
        val app = context.applicationContext
        val id = lock.withLock {
            val live = watchRun
            if (live != null && !live.stopping && live.thread?.isAlive == true) {
                Log.i(TAG, "start: native run ${live.id} is already there")
                return live.id
            }
            pageHolds = false
            val holder = arrayOfNulls<Run>(1)
            val thread = Thread({
                // A push check in flight ends first: one writer of the cursor.
                checkLock.withLock { }
                val run = holder[0]!!
                val end = NativeMailRun(Ports(app, run)).watch()
                Log.i(TAG, "native run ended: ${end.name}") // log-safe: an enum constant
                lock.withLock { if (watchRun === run) watchRun = null }
                if (end != NativeRunEnd.STOPPED) ended.onEnded(run.id, end.name.lowercase())
            }, "canari-mail-native")
            val run = Run(++lastRunId, thread)
            holder[0] = run
            watchRun = run
            thread.start()
            run.id
        }
        registerNetwork(app)
        Log.i(TAG, "native run $id started")
        return id
    }

    /**
     * Stops every native run - the persistent one and a check in flight - and WAITS for them: on
     * return nothing native writes the cursor or posts. [forPage]: the page claims the watch. Never on
     * the main thread.
     */
    fun stopAndJoin(context: Context, why: String, forPage: Boolean = false) {
        val (watch, check) = lock.withLock {
            if (forPage) pageHolds = true
            watchRun to checkRun
        }
        watch?.stop()
        check?.stop()
        watch?.thread?.let {
            Log.i(TAG, "stopping the native run ($why)")
            it.join()
        }
        checkLock.withLock { }
        unregisterNetwork(context.applicationContext)
    }

    /** Stops the run there NOW (captured at the call), without blocking the caller. */
    fun stopAsync(context: Context, why: String) {
        val run = lock.withLock { watchRun } ?: return
        run.stop()
        Thread({
            run.thread?.join()
            Log.i(TAG, "native run stopped ($why)")
            unregisterNetwork(context.applicationContext)
        }, "canari-mail-native-stop").start()
    }

    /** The page stopped watching, or is gone: a push check may read the delta again. */
    fun pageReleased() {
        if (pageHolds) Log.d(TAG, "the page no longer holds the watch")
        pageHolds = false
    }

    /**
     * FORGET - THE ONE ERASE-AND-STOP OP (B1, I4). Erases the sealed copy ([userId]'s, or every copy
     * when `null`: a remote revocation does not know the account), stops and joins every native run,
     * then tells the service ([MailWatchCommand.Forgotten]: a NATIVE watch leaves, a page's goes on).
     * On the vault's ONE executor, so it is ordered after an arm sent before it. Called by the bridge's
     * `forget` (every forget path of the page) and - mail lot 5 - by the FCM service on a
     * `mail-forget` data push (device revoked, account deleted, signed out everywhere).
     */
    fun forget(context: Context, userId: String? = null) {
        val app = context.applicationContext
        MailWatchVault.ops.execute {
            MailWatchVault.erase(app, userId, alsoCursor = false)
            stopAndJoin(app, "the sealed copy is forgotten")
            try {
                app.startService(MailWatchService.intentFor(app, MailWatchCommand.Forgotten))
            } catch (e: IllegalStateException) {
                // A process with no foreground may not start a service; then none holds a watch either.
                Log.i(TAG, "forget: the service was not told (${e.javaClass.simpleName}) - none runs")
            }
            Log.i(TAG, "forgotten: copy erased, native runs stopped")
        }
    }

    /**
     * ONE delta check, then notify - THE ENTRY POINT OF THE PUSH PATH (mail lot 5: the FCM handler
     * calls it on an empty data push that says the mailbox changed). The same sealed copy, cursor file
     * and notices as the persistent run. It does nothing while the page or the persistent native run
     * watches (they notify by themselves); a claim, a forget or a starting run waits for it. Blocking:
     * call it from a worker thread, never the main thread. Needs no foreground service.
     */
    fun checkOnce(context: Context): CheckOutcome {
        val app = context.applicationContext
        if (!checkLock.tryLock()) {
            Log.i(TAG, "check: another check runs - nothing more to read")
            return CheckOutcome.BUSY
        }
        try {
            val run = lock.withLock {
                val live = watchRun
                if ((live != null && live.thread?.isAlive == true) || pageHolds) {
                    Log.i(TAG, "check: a watcher already watches - left to it")
                    return CheckOutcome.WATCHING
                }
                Run(++lastRunId, null).also { checkRun = it }
            }
            val end = NativeMailRun(Ports(app, run)).checkOnce()
            Log.i(TAG, "check: ${end.name}") // log-safe: an enum constant
            return when (end) {
                NativeCheckEnd.DONE -> CheckOutcome.DONE
                NativeCheckEnd.STOPPED -> CheckOutcome.WATCHING
                NativeCheckEnd.NOTHING_SEALED, NativeCheckEnd.DISARMED -> CheckOutcome.NOTHING_SEALED
                NativeCheckEnd.REFUSED -> CheckOutcome.REFUSED
                NativeCheckEnd.ACCOUNT_CLOSED -> CheckOutcome.ACCOUNT_CLOSED
                NativeCheckEnd.UNAVAILABLE -> CheckOutcome.UNAVAILABLE
                NativeCheckEnd.FAILED -> CheckOutcome.FAILED
            }
        } finally {
            lock.withLock { checkRun = null }
            checkLock.unlock()
        }
    }

    /** The platform side of one [Run]. */
    private class Ports(private val context: Context, private val run: Run) : NativeMailPorts {
        /** The account of the copy this run opened: the cursor and the copy checks are its own. */
        private var userId: String? = null

        override fun call(body: JSONObject, token: String?): JSONObject {
            checkStopped()
            return post(soapEnvelope(body, token), publish = true)
        }

        override fun callAfterStop(body: JSONObject, token: String): JSONObject =
            post(soapEnvelope(body, token), publish = false)

        override fun openVault(): NativeVaultRecord? {
            val armed = MailWatchVault.armed(context) ?: return null
            if (userId != null && userId != armed.userId) {
                Log.e(TAG, "the sealed copy now names another account - the run ends")
                return null
            }
            userId = armed.userId
            return MailWatchVault.open(armed)
        }

        override fun stillArmed(): Boolean = userId?.let { MailWatchVault.stillArmed(context, it) } == true

        override fun eraseVault(reason: NativeEraseReason) {
            MailWatchVault.erase(context, userId ?: return, alsoCursor = reason == NativeEraseReason.ACCOUNT_CLOSED)
        }

        private fun cursorFile(): File? = userId?.let { MailWatchVault.cursorFile(context, it) }

        override fun readCursor(): String? = cursorFile()?.takeIf { it.exists() }?.readText()

        /** Atomic, as `write_cursor` in Rust: a sibling file renamed over it. */
        override fun writeCursor(text: String): Boolean {
            val f = cursorFile() ?: return false
            return try {
                f.parentFile?.mkdirs()
                val tmp = File(f.parentFile, "${f.name}.tmp")
                tmp.writeText(text)
                tmp.renameTo(f).also { if (!it) Log.e(TAG, "the cursor was not renamed into place") }
            } catch (e: Exception) {
                Log.e(TAG, "the cursor was not written: ${e.javaClass.simpleName}")
                false
            }
        }

        override fun notify(fresh: List<NativeInboxItem>) = postNotices(context, fresh)

        override fun pause(ms: Long) = run.lock.withLock {
            checkStopped()
            run.wake.await(ms, TimeUnit.MILLISECONDS)
            checkStopped()
        }

        override fun checkStopped() {
            if (run.stopping) throw NativeStopped()
        }

        override fun log(line: String) {
            Log.i(TAG, line) // log-safe: the run's lines name codes, counts, item ids and class names - never content
        }

        /**
         * One POST. With [publish], the connection is published on the run UNDER its lock, after
         * re-reading the stop flag there: a stop either sees it (and cuts it) or is seen here.
         */
        private fun post(envelope: JSONObject, publish: Boolean): JSONObject {
            val conn = URL(NATIVE_MAIL_SOAP_URL).openConnection() as HttpsURLConnection
            if (publish) {
                run.lock.withLock {
                    if (run.stopping) throw NativeStopped()
                    run.connection = conn
                }
            }
            try {
                conn.instanceFollowRedirects = false
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
            } catch (e: IOException) {
                if (publish && run.stopping) throw NativeStopped()
                throw e
            } finally {
                if (publish) run.lock.withLock { if (run.connection === conn) run.connection = null }
                conn.disconnect()
            }
        }
    }

    /** The page's `postMailNotices`, with the app's own words. */
    private fun postNotices(context: Context, fresh: List<NativeInboxItem>) {
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

    /** Wakes the persistent run's pause when a network comes back. */
    private fun registerNetwork(context: Context) {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        lock.withLock {
            if (networkCallback != null) return
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    val run = lock.withLock { watchRun } ?: return
                    run.lock.withLock { run.wake.signalAll() }
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
        val cb = lock.withLock {
            if (watchRun != null) return
            networkCallback.also { networkCallback = null }
        } ?: return
        try {
            cm.unregisterNetworkCallback(cb)
        } catch (e: Exception) {
            Log.i(TAG, "network callback not unregistered: ${e.javaClass.simpleName}")
        }
    }
}
