package fr.emse.canari.mail

import java.security.MessageDigest

/**
 * THE TWO MAIL PUSHES, ROUTED (mail lot 5, docs/wiki/mail-client-transport.md#as-built---lot-5). Pure,
 * so `MailPushTest` asserts it on the JVM.
 *
 * - `mail`: the EMPTY push the account's filter-rule notice triggers (`mail_push = cloudflare`). Nothing
 *   travels but the type: the device reads the new mail itself.
 * - `mail-forget` (D6): the server ended this device's place in the account (revoked, signed out
 *   from elsewhere, account erased) - what it keeps of the school mailbox outside the page goes.
 *   It names the account, so a device holding another account's mailbox by then forgets nothing.
 *   A forget for an ENDED SESSION (`scope: session`) also names the registration that session wrote
 *   ([registrationFingerprintOf]): a device that signed in again before it arrived holds a new push
 *   secret and keeps its mailbox ([forgetApplies]). A revoked device or an erased account forgets
 *   unconditionally.
 */

/** The `type` of the empty mail push (`MAIL_PUSH_TYPE` server side). */
const val MAIL_PUSH_TYPE = "mail"

/** The `type` of the remote forget (`MAIL_FORGET_TYPE` server side). */
const val MAIL_FORGET_TYPE = "mail-forget"

/** What a push asks of the mail half of this app. */
sealed interface MailPushRoute {
    /** Read the inbox now: the native watcher's one check. */
    data object Check : MailPushRoute

    /**
     * Forget everything kept natively for [userId]'s mailbox - unconditionally when [registration]
     * is `null` (a revoked device, an erased account), else only per [forgetApplies].
     */
    data class Forget(val userId: String, val registration: String? = null) : MailPushRoute

    /** A `mail-forget` naming no account: nothing can be decided, so nothing is erased (logged). */
    data object ForgetWithoutAccount : MailPushRoute
}

/** The route of a push's data map, or `null` when the push is not a mail push. */
fun mailPushRouteOf(data: Map<String, String>): MailPushRoute? = when (data["type"]) {
    MAIL_PUSH_TYPE -> MailPushRoute.Check
    MAIL_FORGET_TYPE -> data["userId"]?.takeIf { it.isNotBlank() }?.let {
        // Only an ended session is conditional; '' is a legacy row with no secret to name.
        MailPushRoute.Forget(it, if (data["scope"] == "session") data["registration"] ?: "" else null)
    } ?: MailPushRoute.ForgetWithoutAccount
    else -> null
}

/**
 * The fingerprint of the registration whose RAW push secret this device holds - the server's
 * `registrationFingerprint` of the stored hash: the first 32 hex characters of
 * `sha256("canari-mail-forget|" + hex(sha256(raw)))`. One vector holds the server, this and Rust
 * together (`mailPushSecret.test.ts`).
 */
fun registrationFingerprintOf(rawSecret: String): String {
    val stored = sha256Hex(rawSecret)
    return sha256Hex("canari-mail-forget|$stored").substring(0, 32)
}

private fun sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

/**
 * Whether a [MailPushRoute.Forget] erases this device's copy: always when it names no registration;
 * for an ended session, when this device is signed out of Canari, or when its CURRENT push secret is
 * the ended registration's. A device that signed in again has a new secret: it keeps its mailbox. A
 * secret that cannot be read while signed in (`null`) proves nothing, so nothing is erased.
 */
fun forgetApplies(route: MailPushRoute.Forget, currentRawSecret: String?, signedOut: Boolean): Boolean {
    val registration = route.registration ?: return true
    if (signedOut) return true
    if (registration.isEmpty() || currentRawSecret == null) return false
    return registrationFingerprintOf(currentRawSecret) == registration
}

