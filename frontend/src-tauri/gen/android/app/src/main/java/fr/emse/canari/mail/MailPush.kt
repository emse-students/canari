package fr.emse.canari.mail

/**
 * THE TWO MAIL PUSHES, ROUTED (mail lot 5, docs/wiki/mail-client-transport.md#as-built---lot-5). Pure,
 * so `MailPushTest` asserts it on the JVM.
 *
 * - `mail`: the EMPTY push the account's filter-rule notice triggers (`mail_push = cloudflare`). Nothing
 *   travels but the type: the device reads the new mail itself.
 * - `mail-forget` (D6): the server ended this device's place in the account (revoked, signed out
 *   from elsewhere, account erased) - what it keeps of the school mailbox outside the page goes.
 *   It names the account, so a device holding another account's mailbox by then forgets nothing.
 */

/** The `type` of the empty mail push (`MAIL_PUSH_TYPE` server side). */
const val MAIL_PUSH_TYPE = "mail"

/** The `type` of the remote forget (`MAIL_FORGET_TYPE` server side). */
const val MAIL_FORGET_TYPE = "mail-forget"

/** What a push asks of the mail half of this app. */
sealed interface MailPushRoute {
    /** Read the inbox now: the native watcher's one check. */
    data object Check : MailPushRoute

    /** Forget everything kept natively for [userId]'s mailbox. */
    data class Forget(val userId: String) : MailPushRoute

    /** A `mail-forget` naming no account: nothing can be decided, so nothing is erased (logged). */
    data object ForgetWithoutAccount : MailPushRoute
}

/** The route of a push's data map, or `null` when the push is not a mail push. */
fun mailPushRouteOf(data: Map<String, String>): MailPushRoute? = when (data["type"]) {
    MAIL_PUSH_TYPE -> MailPushRoute.Check
    MAIL_FORGET_TYPE -> data["userId"]?.takeIf { it.isNotBlank() }?.let { MailPushRoute.Forget(it) }
        ?: MailPushRoute.ForgetWithoutAccount
    else -> null
}

