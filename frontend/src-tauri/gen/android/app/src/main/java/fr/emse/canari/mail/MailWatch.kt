package fr.emse.canari.mail

/**
 * THE MAIL WATCH SERVICE'S DECISIONS, WITH NOTHING FROM ANDROID IN THEM (lot 4,
 * docs/wiki/mail-client-transport.md#as-built---lot-4).
 *
 * The new-mail watcher runs in the page; [fr.emse.canari.MailWatchService] only keeps the process in
 * the foreground while it does (the persistent connection of D11). Every command reaching the service
 * goes through [decideMailWatch], and every notice the page hands the native builder through
 * [mailNoticeOf] - pure, so `android-tests` runs both on a JVM (`MailWatchTest`).
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see `PushRecoveryLadder`).
 */

/** The persistent notification while the service holds the foreground: Paraglide text from the page. */
data class MailWatchSpec(val title: String, val text: String)

/** What reaches the service. */
sealed interface MailWatchCommand {
    /** The page's watch runs: hold the foreground with [spec]. */
    data class Start(val spec: MailWatchSpec) : MailWatchCommand

    /** The page's watch stopped (the switch off, a sign-out, D8, `mail_mode` off). */
    data class Stop(val reason: String) : MailWatchCommand

    /** The page is gone (the activity destroyed): nothing watches any more. */
    data object PageGone : MailWatchCommand

    /** The user swiped the app away: the page goes with the task. */
    data object TaskRemoved : MailWatchCommand
}

/** What the service does about a command. */
sealed interface MailWatchEffect {
    data class EnterForeground(val spec: MailWatchSpec) : MailWatchEffect

    /** Already in the foreground: the notification's text is redrawn (a language change). */
    data class Refresh(val spec: MailWatchSpec) : MailWatchEffect

    data class Leave(val reason: String) : MailWatchEffect

    data class Ignore(val reason: String) : MailWatchEffect
}

/**
 * The one transition table. THE SERVICE NEVER OUTLIVES THE PAGE: the watcher lives in the page, so a
 * foreground held with no page would be a persistent notification promising a watch nobody runs.
 */
fun decideMailWatch(running: Boolean, command: MailWatchCommand): MailWatchEffect = when (command) {
    is MailWatchCommand.Start ->
        if (running) MailWatchEffect.Refresh(command.spec) else MailWatchEffect.EnterForeground(command.spec)
    is MailWatchCommand.Stop ->
        if (running) MailWatchEffect.Leave(command.reason) else MailWatchEffect.Ignore("stop with no watch held (${command.reason})")
    MailWatchCommand.PageGone ->
        if (running) MailWatchEffect.Leave("the page is gone") else MailWatchEffect.Ignore("page gone with no watch held")
    MailWatchCommand.TaskRemoved ->
        if (running) MailWatchEffect.Leave("the task was removed from Recents") else MailWatchEffect.Ignore("task removed with no watch held")
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
