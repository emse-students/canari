package fr.emse.canari.push

/**
 * THE NICKNAME A NOTIFICATION GIVES A MEMBER OF ITS CONVERSATION, as a pure lookup (owner,
 * 2026-11-14: "comme sur Messenger, tous les pseudos" - a notification names a member by the
 * nickname set in THAT conversation, whoever set it, lock screen included; and "Tout pourrait etre
 * donne par l'appareil et rien par le serveur": the device composes the name, no push carries one).
 *
 * The book is `conversation_nicknames.json`, written by the WebView (`nicknameMirror.ts`, Rust
 * `store_conversation_nicknames`) with the nicknames this account may SEE - the block rule of the
 * screen is applied before the write, so nothing here applies one. `scopes` maps an MLS group id, or a
 * community's `community:<id>`, to {member id: nickname}; `channels` places a salon in its community,
 * since a salon push names the salon only. The service parses the file ([Book]); this decides.
 *
 * The rule is `libs/contracts/notification-nickname.cases.json`, asserted by `ConversationNicknamesTest`
 * and by the client, the iOS extension, `canari_push.mm` and Rust on the same cases. A null answer
 * means "no nickname": the caller keeps the name it already had (the phone's copy of profile names,
 * `display_names.json`, or the push's own field for an MLS frame).
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see [PushRecoveryLadder]).
 */
object ConversationNicknames {

    /**
     * One account's book, as parsed from the file.
     *
     * @property owner the account the file names (lower-cased).
     * @property scopes scope -> lower-cased member id -> nickname.
     * @property channels salon id (no `channel_` prefix) -> its community's scope.
     */
    class Book(
        val owner: String,
        val scopes: Map<String, Map<String, String>>,
        val channels: Map<String, String>,
    )

    /**
     * The nickname [memberId] carries in a conversation, or null.
     *
     * @param book the parsed file, null when there is none (absent, unreadable).
     * @param me the signed-in account (`push_context.json`); another account's book is never read.
     * @param salon whether [conversation] is a salon id (its `channel_` prefix allowed), read through
     *   the book's `channels`; otherwise it is an MLS group id, itself the scope.
     */
    fun of(book: Book?, me: String?, salon: Boolean, conversation: String, memberId: String): String? {
        if (book == null) return null
        val owner = me?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        if (book.owner != owner) return null
        val scope = if (salon) {
            book.channels[conversation.removePrefix("channel_")] ?: return null
        } else {
            conversation
        }
        return book.scopes[scope]?.get(memberId.trim().lowercase())?.trim()?.takeIf { it.isNotEmpty() }
    }
}
