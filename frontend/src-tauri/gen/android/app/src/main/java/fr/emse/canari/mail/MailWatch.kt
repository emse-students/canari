package fr.emse.canari.mail

/**
 * THE MAIL WATCH SERVICE'S DECISIONS, WITH NOTHING FROM ANDROID IN THEM (lot 4,
 * docs/wiki/mail-client-transport.md#as-built---lot-4).
 *
 * The new-mail watcher runs in the page while there is one; [fr.emse.canari.MailWatchService] keeps
 * the process in the foreground while it does (the persistent connection of D11), and with no page
 * runs the native watcher of lot 4b ([MailWatchMode.NATIVE], `NativeMailWatch.kt`). Every command reaching the service
 * goes through [decideMailWatch], and every notice the page hands the native builder through
 * [mailNoticeOf] - pure, so `android-tests` runs both on a JVM (`MailWatchTest`).
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see `PushRecoveryLadder`).
 */

/** The persistent notification while the service holds the foreground: the page's Paraglide text, or the native resources' at a resume. */
data class MailWatchSpec(val title: String, val text: String)

/** Who watches while the service holds the foreground (lot 4b). */
enum class MailWatchMode {
    /** Nothing held. */
    OFF,

    /** The page's watcher runs (`mailWatcher.ts`); the service only keeps the process's network. */
    PAGE,

    /** No page: the native watcher runs from the sealed copy ([NativeVaultRecord]). */
    NATIVE,
}

/** What reaches the service. */
sealed interface MailWatchCommand {
    /** The page's watch runs: hold the foreground with [spec]. */
    data class Start(val spec: MailWatchSpec) : MailWatchCommand

    /** The page's watch is not wanted (the switch off, a sign-out, D8, `mail_mode` off): ALL of it ends. */
    data class Stop(val reason: String) : MailWatchCommand

    /** The page is gone (the activity destroyed, or a new document replaced it). */
    data object PageGone : MailWatchCommand

    /** The user swiped the app away: the page goes with the task. */
    data object TaskRemoved : MailWatchCommand

    /** No page, and a reason to watch again: the phone booted, the app was updated, or the system
     *  restarted the service after killing the process. [spec] is the native resources' text. */
    data class Resume(val spec: MailWatchSpec) : MailWatchCommand

    /**
     * The native run [run] ended by itself (the password refused, the account closed, the sealed copy
     * erased). [run] is the id [fr.emse.canari.NativeMailWatcher.start] gave it: the end of an EARLIER
     * run, delivered after a new one started, ends nothing.
     */
    data class NativeEnded(val reason: String, val run: Long) : MailWatchCommand

    /** The sealed copy was forgotten and every native run joined (`NativeMailWatcher.forget`). */
    data object Forgotten : MailWatchCommand
}

/** What the service does about a command. */
sealed interface MailWatchEffect {
    data class EnterForeground(val spec: MailWatchSpec, val mode: MailWatchMode) : MailWatchEffect

    /** Already in the foreground for the page: the notification's text is redrawn (a language change). */
    data class Refresh(val spec: MailWatchSpec) : MailWatchEffect

    /** The page takes the watch back: the native run stops (the page claimed it first, joined). */
    data class HandToPage(val spec: MailWatchSpec) : MailWatchEffect

    /** The page went and a sealed copy is there: the foreground stays, the native watcher starts. */
    data object HandToNative : MailWatchEffect

    data class Leave(val reason: String) : MailWatchEffect

    data class Ignore(val reason: String) : MailWatchEffect
}

/**
 * The one transition table. [armed] is whether a sealed copy exists (the user ticked "remember" AND
 * turned the switch on - the page arms it only then, and every forget path erases it). [currentRun]
 * is the id of the native run the service started last.
 *
 * - THE PAGE WINS while it watches: a start hands the watch to it, from either state.
 * - A page that goes leaves the watch to the native watcher when armed, else ends it.
 * - NOTHING BUT A STOP, A FORGET OR ITS OWN END ENDS A NATIVE RUN: it is the watch with no page.
 */
fun decideMailWatch(mode: MailWatchMode, command: MailWatchCommand, armed: Boolean, currentRun: Long = 0): MailWatchEffect = when (command) {
    is MailWatchCommand.Start -> when (mode) {
        MailWatchMode.OFF -> MailWatchEffect.EnterForeground(command.spec, MailWatchMode.PAGE)
        MailWatchMode.PAGE -> MailWatchEffect.Refresh(command.spec)
        MailWatchMode.NATIVE -> MailWatchEffect.HandToPage(command.spec)
    }
    is MailWatchCommand.Stop ->
        if (mode != MailWatchMode.OFF) MailWatchEffect.Leave(command.reason) else MailWatchEffect.Ignore("stop with no watch held (${command.reason})")
    MailWatchCommand.PageGone, MailWatchCommand.TaskRemoved -> {
        val what = if (command == MailWatchCommand.PageGone) "the page is gone" else "the task was removed from Recents"
        when (mode) {
            MailWatchMode.PAGE -> if (armed) MailWatchEffect.HandToNative else MailWatchEffect.Leave("$what, nothing sealed")
            MailWatchMode.NATIVE -> MailWatchEffect.Ignore("$what - the native watcher runs without it")
            MailWatchMode.OFF -> MailWatchEffect.Ignore("$what with no watch held")
        }
    }
    is MailWatchCommand.Resume -> when {
        mode != MailWatchMode.OFF -> MailWatchEffect.Ignore("resume while already watching")
        armed -> MailWatchEffect.EnterForeground(command.spec, MailWatchMode.NATIVE)
        else -> MailWatchEffect.Ignore("resume with nothing sealed")
    }
    is MailWatchCommand.NativeEnded -> when {
        mode != MailWatchMode.NATIVE -> MailWatchEffect.Ignore("a native end while not native (${command.reason})")
        command.run != currentRun -> MailWatchEffect.Ignore("the end of an earlier native run (${command.reason})")
        else -> MailWatchEffect.Leave(command.reason)
    }
    MailWatchCommand.Forgotten ->
        if (mode == MailWatchMode.NATIVE) MailWatchEffect.Leave("the sealed copy is forgotten")
        else MailWatchEffect.Ignore("forgotten - the page's watch (if any) is the page's to stop")
}

/** The tag every new-mail notification is posted under: its id is the message's, in its own space. */
const val MAIL_NOTIFICATION_TAG = "canari_mail"

/** The only links a mail notice may open: the Mail tab of this app. */
private const val MAIL_LINK_PREFIX = "fr.emse.canari://mail"

/** One new-mail notification, as the page described it and the builder posts it. */
data class MailNotice(
    /** The message's Zimbra item id: the notification id under [MAIL_NOTIFICATION_TAG]. */
    val itemId: Int,
    val title: String,
    val body: String,
    /** What the lock screen shows when the reader hides sensitive content (the OS setting). */
    val publicTitle: String,
    val link: String,
)

/** Why a notice the page handed over is refused (logged; nothing is posted). */
enum class MailNoticeRefusal { ITEM_ID, TEXT, LINK }

/**
 * The notice of the page's fields, or why it is refused. THE LINK IS AN ALLOWLIST: it becomes an
 * `ACTION_VIEW` intent to the app, so only `fr.emse.canari://mail` and `fr.emse.canari://mail/<id>`
 * pass - never another host or scheme, whatever the page sends.
 */
fun mailNoticeOf(itemId: Long, title: String, body: String, publicTitle: String, link: String): Result<MailNotice> {
    if (itemId < 0 || itemId > Int.MAX_VALUE) return Result.failure(MailNoticeError(MailNoticeRefusal.ITEM_ID))
    if (title.isBlank() || publicTitle.isBlank()) return Result.failure(MailNoticeError(MailNoticeRefusal.TEXT))
    val linkOk = link == MAIL_LINK_PREFIX ||
        (link.startsWith("$MAIL_LINK_PREFIX/") && link.length > MAIL_LINK_PREFIX.length + 1 &&
            link.substring(MAIL_LINK_PREFIX.length + 1).none { it == '/' || it == '?' || it == '#' || it.isWhitespace() })
    if (!linkOk) return Result.failure(MailNoticeError(MailNoticeRefusal.LINK))
    return Result.success(MailNotice(itemId.toInt(), title, body, publicTitle, link))
}

/** A refused notice, typed by its [refusal]. */
class MailNoticeError(val refusal: MailNoticeRefusal) : IllegalArgumentException("mail notice refused: $refusal")

/** The tag of the ONE notice standing for a flood of new mails (more than the page notifies singly). */
const val MAIL_SUMMARY_TAG = "canari_mail_summary"

/** The tag of the shade's group summary that bundles the single notices (Android draws it as a stack). */
const val MAIL_GROUP_SUMMARY_TAG = "canari_mail_group"

/** The summary of [count] new mails: it opens the inbox. */
data class MailSummary(val count: Int, val title: String, val body: String, val publicTitle: String, val link: String)

/** The summary of the page's fields, or why it is refused - the same text and link rules as [mailNoticeOf]. */
fun mailSummaryOf(count: Long, title: String, body: String, publicTitle: String, link: String): Result<MailSummary> {
    if (count < 1 || count > Int.MAX_VALUE) return Result.failure(MailNoticeError(MailNoticeRefusal.ITEM_ID))
    return mailNoticeOf(0, title, body, publicTitle, link).map { MailSummary(count.toInt(), it.title, it.body, it.publicTitle, it.link) }
}

/** What the page's bridge may ask, one JSON message each (`androidMailWatch.ts`). */
enum class MailBridgeOp(val wire: String) {
    START("start"), STOP("stop"), NOTIFY("notify"), SUMMARY("summary"),

    /** A new document: the page before it is gone (`PageGone`). */
    PAGE("page"),

    /** The page's watcher is about to run: the native run stops, joined, then `handed` answers. */
    CLAIM("claim"),

    /** Seal the password for the native watcher (lot 4b): only with "remember" ticked AND the switch on. */
    ARM("arm"),

    /** EVERY forget path: erase the sealed copy AND stop every native run, as one op (review B1). */
    FORGET("forget"),

    /** The page's watcher stopped: a push check may read the delta again (review minor 3). */
    RELEASE("release");

    companion object {
        fun of(wire: String): MailBridgeOp? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * Whether a bridge message may be acted on: from the TOP frame only, whatever the origin rule let
 * through - a frame inside the page (a mail's sandbox) never drives the service or posts a notice.
 */
fun mailBridgeMessageAccepted(isMainFrame: Boolean, origin: String?, allowedOrigins: Set<String>): Boolean =
    isMainFrame && origin != null && origin in allowedOrigins

/** The release app's one origin. */
const val MAIL_BRIDGE_RELEASE_ORIGIN = "http://tauri.localhost"

/**
 * The origins the bridge listens to: the app's own, and in a DEBUG build the dev server's too
 * (`devUrl`, and `TAURI_DEV_HOST`'s when a phone loads it over the network: [devHost]) - never a
 * wildcard (review minor 8).
 */
fun mailBridgeOrigins(debug: Boolean, devHost: String?): Set<String> {
    if (!debug) return setOf(MAIL_BRIDGE_RELEASE_ORIGIN)
    val origins = linkedSetOf(MAIL_BRIDGE_RELEASE_ORIGIN, "http://127.0.0.1:1420", "http://localhost:1420")
    val host = devHost?.trim().orEmpty()
    if (host.isNotEmpty() && host.none { it == '/' || it == ':' || it.isWhitespace() }) origins += "http://$host:1420"
    return origins
}
