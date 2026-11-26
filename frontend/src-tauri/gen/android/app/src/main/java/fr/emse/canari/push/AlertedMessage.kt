package fr.emse.canari.push

/**
 * WHICH MESSAGE A BANNER ANNOUNCED: the conversation, the sender and the sender's instant.
 *
 * Two members of one conversation can write in the SAME millisecond - nothing synchronises their
 * clocks, so it is a coincidence and it does happen. An identity made of the instant alone made the
 * second one "already announced": silent, and its line in the shade taken for the first's. The
 * iOS ledger carries the sender since #3968 (`<conversation>:<sender>:<instant>`); this is the
 * Android half. See `ios-notification-ownership.md`.
 *
 * ONE PREDICATE FOR TWO STORES. The shade's own lines (`MessagingStyle` messages, the sender in an
 * extra) and the persisted set of announced keys both ask [sameSender], so they cannot disagree.
 *
 * A SENDER THE TRIGGER DID NOT KNOW IS NOT A DIFFERENT SENDER. A blind salon push names nobody
 * while the socket frame of the same message may name them: "unknown" matches anyone, so the two
 * triggers still make ONE message, exactly as before this key carried a sender. The price is that
 * a blind line cannot be told from a same-millisecond line of another member, the case that was
 * always accepted.
 *
 * Keys of the older format (`<conversation>:<instant>`, no sender) read as unknown and never match
 * a new one: they age out of the bounded set, at worst one message announced again, never one lost.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
object AlertedMessage {

    /** The persisted identity of one announced message. [senderId] empty when the trigger had none. */
    fun key(notifKey: String, senderId: String, sentAt: Long): String =
        "$notifKey:${normalise(senderId)}:$sentAt"

    /** Both senders are known and differ, which is the only case that tells two messages apart. */
    fun sameSender(a: String, b: String): Boolean {
        val left = normalise(a)
        val right = normalise(b)
        return left.isEmpty() || right.isEmpty() || left == right
    }

    /**
     * Whether a [stored] key and a [probe] name the same message. A stored key of the older format
     * (no sender segment) is never one: it is read as unknown at its own risk, which the bound ages out.
     */
    fun matches(stored: String, probe: String): Boolean {
        val s = split(stored) ?: return false
        val p = split(probe) ?: return false
        return s.conversation == p.conversation && s.sentAt == p.sentAt && sameSender(s.sender, p.sender)
    }

    private class Parts(val conversation: String, val sender: String, val sentAt: String)

    /** `<conversation>:<sender>:<instant>`, parsed from the right; null for the old two-part form. */
    private fun split(key: String): Parts? {
        val last = key.lastIndexOf(':')
        if (last < 0) return null
        val mid = key.lastIndexOf(':', last - 1)
        if (mid < 0) return null
        return Parts(key.substring(0, mid), key.substring(mid + 1, last), key.substring(last + 1))
    }

    private fun normalise(senderId: String): String = senderId.trim().lowercase()
}
