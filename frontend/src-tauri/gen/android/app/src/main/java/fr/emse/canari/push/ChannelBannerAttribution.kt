package fr.emse.canari.push

/**
 * WHAT A SALON BANNER MAY SAY ABOUT WHO WROTE IT, as a pure function (2026-10-22).
 *
 * A salon push names its author (`senderId`) and whether it mentions this reader (`mentioned`),
 * and both are the SERVER's words. The author is proven only by opening the message: under a v2
 * session the native reader refuses an author who is not the session's minter and a row whose
 * signature does not verify (channel-encryption section 21.5). So a banner that shows the decrypted
 * text ([showsMessage]) may draw the author's face and "<name> mentioned you"; a BLIND banner (no
 * seed, no ciphertext inlined, an open that was refused) shows the generic line and nothing about
 * an author - the face and the mention would be the server's claim drawn as if it were proven.
 *
 * The mention also decides the urgent route (`canari_mentions` on Android, a time-sensitive level
 * on iOS), and that route follows the same rule: a claim nobody proved does not break through.
 * A blind banner redrawn with its plaintext once the seed lands takes both back. A held v1 session
 * opens with no author check at all, as it does in the app - the documented legacy reader, gone
 * when production counts no unsigned row (`legacy-compatibility`).
 *
 * iOS twin: `NotificationService.channelBannerAttribution`. Compiled by the JVM test project too,
 * so nothing here may import Android - see [PushRecoveryLadder] for why that is the guard.
 */
object ChannelBannerAttribution {

    /**
     * What the banner draws about its author.
     *
     * @property authorId   the user whose face the banner draws, or null for the salon's initials.
     * @property mentionsMe whether the banner says "<name> mentioned you" and takes the mention route.
     */
    data class Attribution(val authorId: String?, val mentionsMe: Boolean)

    /**
     * @param showsMessage       whether the banner's body IS the decrypted text.
     * @param senderId           the push's `senderId`.
     * @param serverSaysMentioned the push's `mentioned == "true"`.
     */
    fun of(showsMessage: Boolean, senderId: String, serverSaysMentioned: Boolean): Attribution =
        if (!showsMessage) {
            Attribution(authorId = null, mentionsMe = false)
        } else {
            Attribution(authorId = senderId.takeIf { it.isNotEmpty() }, mentionsMe = serverSaysMentioned)
        }
}
