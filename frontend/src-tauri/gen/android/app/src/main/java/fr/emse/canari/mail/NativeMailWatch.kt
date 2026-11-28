package fr.emse.canari.mail

import org.json.JSONArray
import org.json.JSONObject

/**
 * THE NATIVE NEW-MAIL WATCHER'S RULES, WITH NOTHING FROM ANDROID IN THEM (lot 4b,
 * docs/wiki/mail-client-transport.md#as-built---lot-4b-the-native-android-watcher).
 *
 * The owner decided on 2026-11-28 that the Android watch restarts by itself at boot and after the
 * app's process is killed ("un maximum pratique pour l'utilisateur"). With no page there, a NATIVE
 * watcher runs the page's protocol (`mailWatcher.ts`) to the letter: the same requests, the same two
 * questions (a wait set says THAT the mailbox changed, the durable cursor says WHAT is new), the same
 * cursor file read and written by both, the same rate ladder. Every rule it follows is here, pure,
 * so `android-tests` holds it to the page's (`NativeMailWatchTest`): what a request says, what an
 * answer means, where the delta stops, what a notice shows.
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see `PushRecoveryLadder`).
 */

/** The school's mail server: the page's `MAIL_HOST` (`soapClient.ts`), HTTPS on 443. */
const val NATIVE_MAIL_HOST = "partage.emse.fr"

/** Zimbra's SOAP endpoint on [NATIVE_MAIL_HOST]: the page's `SOAP_PATH`. */
const val NATIVE_MAIL_SOAP_URL = "https://$NATIVE_MAIL_HOST/service/soap"

/**
 * What a native wait asks the server for: 300 s, FIVE TIMES the page's `WAIT_TIMEOUT_SECONDS`. The
 * page's 60 s exists only to stay under the web relay's 100 s idle close; the native watcher talks to
 * the server directly, with no relay, so it asks for the longest hold MEASURED on Partage - a wait
 * with no timeout given answered after 303 s (2026-11-27), the server's own default. One wake-up of
 * the radio per five minutes instead of one per minute when nothing happens (the battery reading of
 * MAIL-N compares the two). A longer request is not measured; a server that capped it lower would
 * only answer sooner (an empty wake, a round trip more), never miss a change.
 */
const val NATIVE_WAIT_TIMEOUT_SECONDS = 300

/** The page's `DELTA_PAGE_SIZE`. */
const val NATIVE_DELTA_PAGE_SIZE = 50

/** The page's `MAX_SINGLE_NOTICES` (`mailNotify.ts`): beyond it, one summary. */
const val NATIVE_MAX_SINGLE_NOTICES = 5

private const val ACCOUNT_NS = "urn:zimbraAccount"
private const val MAIL_NS = "urn:zimbraMail"
private const val CURSOR_VERSION = 1

/** The envelope of one call, with the session token when there is one (`soapEnvelope`). */
fun soapEnvelope(body: JSONObject, authToken: String?): JSONObject {
    val envelope = JSONObject().put("Body", body)
    if (authToken != null) {
        envelope.put(
            "Header",
            JSONObject().put(
                "context",
                JSONObject().put("_jsns", "urn:zimbra").put("authToken", JSONObject().put("_content", authToken)),
            ),
        )
    }
    return envelope
}

/** `AuthRequest`: the address and the password (`authRequest`). */
fun nativeAuthRequest(address: String, password: String): JSONObject = JSONObject().put(
    "AuthRequest",
    JSONObject()
        .put("_jsns", ACCOUNT_NS)
        .put("account", JSONObject().put("by", "name").put("_content", address))
        .put("password", JSONObject().put("_content", password)),
)

/** `CreateWaitSetRequest` on the account's messages (`createWaitSetRequest`). */
fun nativeCreateWaitSetRequest(address: String): JSONObject = JSONObject().put(
    "CreateWaitSetRequest",
    JSONObject()
        .put("_jsns", MAIL_NS)
        .put("defTypes", "m")
        .put("add", JSONObject().put("a", JSONArray().put(JSONObject().put("name", address)))),
)

/** `WaitSetRequest`: blocks until a change after [seq] (`waitSetRequest`). */
fun nativeWaitSetRequest(waitSet: String, seq: String): JSONObject = JSONObject().put(
    "WaitSetRequest",
    JSONObject()
        .put("_jsns", MAIL_NS)
        .put("waitSet", waitSet)
        .put("seq", seq)
        .put("block", 1)
        .put("timeout", NATIVE_WAIT_TIMEOUT_SECONDS),
)

/** `DestroyWaitSetRequest` (`destroyWaitSetRequest`). */
fun nativeDestroyWaitSetRequest(waitSet: String): JSONObject =
    JSONObject().put("DestroyWaitSetRequest", JSONObject().put("_jsns", MAIL_NS).put("waitSet", waitSet))

/**
 * One page of the inbox by id, newest first, below the item [after] when given (`inboxPage`): a
 * Zimbra cursor, never an offset, so a mail landing between two pages shifts nothing.
 */
fun nativeInboxPageRequest(after: String?): JSONObject {
    val search = JSONObject()
        .put("_jsns", MAIL_NS)
        .put("query", "inid:\"2\"")
        .put("types", "message")
        .put("sortBy", "idDesc")
        .put("offset", 0)
        .put("limit", NATIVE_DELTA_PAGE_SIZE)
    if (after != null) search.put("cursor", JSONObject().put("id", after).put("sortVal", after))
    return JSONObject().put("SearchRequest", search)
}

/** What a Zimbra fault means to the watcher. */
enum class NativeMailFault {
    /** The password is refused, or must be changed: the sealed copy is useless and goes. */
    BAD_CREDENTIALS,

    /** The session token lapsed: sign in again from the sealed copy (free only after a normal wait). */
    SESSION_EXPIRED,

    /** The server no longer holds the wait set: create another. */
    WAIT_LOST,

    /** The school closed the account (answered to the sign-in itself): D8 - copy and cursor erased. */
    ACCOUNT_CLOSED,

    /** The account is inactive, locked or pending: the run ends, nothing erased. */
    UNAVAILABLE,

    /** Anything else: retried at the ladder's rate. */
    OTHER,
}

/** Who answered a fault: the sign-in itself (about THIS account), or any other call. */
enum class NativeFaultOrigin { AUTH, CALL }

/**
 * THE PAGE'S FAULT TABLE (`FAULT_KINDS` in `mailErrors.ts`), code -> the page's kind, copied here
 * because the app cannot read a repository file at run time. BOTH are held equal to
 * `libs/contracts/mail-fault-kinds.json` (`NativeMailWatchTest`, `mailErrors.test.ts`): a code added
 * on one side only fails a test.
 */
val NATIVE_PAGE_FAULT_KINDS: Map<String, String> = mapOf(
    "account.AUTH_FAILED" to "bad_credentials",
    "account.CHANGE_PASSWORD" to "password_change_required",
    "account.ACCOUNT_INACTIVE" to "account_unavailable",
    "account.NO_SUCH_ACCOUNT" to "not_found",
    "account.MAINTENANCE_MODE" to "maintenance",
    "service.AUTH_REQUIRED" to "session_expired",
    "service.AUTH_EXPIRED" to "session_expired",
    "mail.NO_SUCH_MSG" to "not_found",
    "mail.NO_SUCH_CONV" to "not_found",
    "mail.NO_SUCH_FOLDER" to "not_found",
    "mail.NO_SUCH_ITEM" to "not_found",
    "mail.NO_SUCH_PART" to "not_found",
    "mail.NO_SUCH_UPLOAD" to "not_found",
    "mail.QUERY_PARSE_ERROR" to "invalid_query",
    "mail.MESSAGE_TOO_BIG" to "too_large",
    "mail.UPLOAD_REJECTED" to "too_large",
    "mail.QUOTA_EXCEEDED" to "quota_exceeded",
    "admin.NO_SUCH_WAITSET" to "wait_lost",
)

/** The page's `AUTH_FAULT_KINDS`: what a code means only when the sign-in itself answered it. */
val NATIVE_PAGE_AUTH_FAULT_KINDS: Map<String, String> = mapOf(
    "account.NO_SUCH_ACCOUNT" to "account_closed",
)

/** The page's `faultKind(code, origin)`. */
fun pageFaultKind(code: String, origin: NativeFaultOrigin): String =
    (if (origin == NativeFaultOrigin.AUTH) NATIVE_PAGE_AUTH_FAULT_KINDS[code] else null)
        ?: NATIVE_PAGE_FAULT_KINDS[code] ?: "server"

/** The fault's code (`Detail.Error.Code`), or `null` when the body is not a fault. */
fun faultCodeOf(envelope: JSONObject): String? =
    envelope.optJSONObject("Body")?.optJSONObject("Fault")?.optJSONObject("Detail")?.optJSONObject("Error")
        ?.optString("Code", "")?.takeIf { it.isNotEmpty() }

/** What the watcher does about a fault: the page's kind for it, then the watcher's class of that kind. */
fun nativeFaultOf(code: String, origin: NativeFaultOrigin): NativeMailFault = when (pageFaultKind(code, origin)) {
    "bad_credentials", "password_change_required" -> NativeMailFault.BAD_CREDENTIALS
    "session_expired" -> NativeMailFault.SESSION_EXPIRED
    "wait_lost" -> NativeMailFault.WAIT_LOST
    "account_closed" -> NativeMailFault.ACCOUNT_CLOSED
    "account_unavailable" -> NativeMailFault.UNAVAILABLE
    else -> NativeMailFault.OTHER
}

/**
 * The ONE normalisation of a mailbox address, the page's `normalized` (`mailSession.ts`): trimmed,
 * lower case. The sealed record, the cursor and the comparison between them all go through it.
 */
fun nativeAddress(address: String): String = address.trim().lowercase(java.util.Locale.ROOT)

/** An answer that is not what its request promises: retried, never guessed at. */
class NativeMailUnreadable(what: String) : IllegalStateException("unreadable answer: $what")

private fun responseOf(envelope: JSONObject, name: String): JSONObject =
    envelope.optJSONObject("Body")?.optJSONObject(name) ?: throw NativeMailUnreadable(name)

/** A Zimbra `{_content}` or a plain string. */
private fun contentOf(value: Any?): String? = when (value) {
    is String -> value
    is JSONObject -> value.optString("_content", "").takeIf { it.isNotEmpty() }
    is JSONArray -> contentOf(value.opt(0))
    else -> null
}

/** The session token of an `AuthResponse`. */
fun authTokenOf(envelope: JSONObject): String =
    contentOf(responseOf(envelope, "AuthResponse").opt("authToken")) ?: throw NativeMailUnreadable("authToken")

/** The wait set and its first `seq` - a STRING, `"0"` on Partage (measured 2026-11-28). */
data class NativeWaitSet(val id: String, val seq: String)

fun waitSetOf(envelope: JSONObject): NativeWaitSet {
    val r = responseOf(envelope, "CreateWaitSetResponse")
    val id = r.optString("waitSet", "").takeIf { it.isNotEmpty() } ?: throw NativeMailUnreadable("waitSet")
    return NativeWaitSet(id, r.opt("seq")?.toString() ?: throw NativeMailUnreadable("seq"))
}

/** A wait's answer (`parseWaitSetAnswer`): a change lists the account in `a`; `seq` moves each wake. */
data class NativeWaitAnswer(val seq: String, val changed: Boolean, val canceled: Boolean)

fun waitAnswerOf(envelope: JSONObject): NativeWaitAnswer {
    val r = responseOf(envelope, "WaitSetResponse")
    val seq = r.opt("seq")?.toString() ?: throw NativeMailUnreadable("seq")
    val a = r.opt("a")
    val changed = (a is JSONArray && a.length() > 0) || a is JSONObject
    val canceled = r.opt("canceled").let { it == true || it == "1" || it == "true" }
    return NativeWaitAnswer(seq, changed, canceled)
}

/** One inbox message of a delta: what a notice is made of. */
data class NativeInboxItem(
    val id: String,
    val conversationId: String?,
    val senderName: String?,
    val senderAddress: String?,
    val subject: String?,
    val unread: Boolean,
)

/** One page of the inbox, and whether the server holds more below it. */
data class NativeInboxPage(val items: List<NativeInboxItem>, val more: Boolean)

fun inboxPageOf(envelope: JSONObject): NativeInboxPage {
    val r = responseOf(envelope, "SearchResponse")
    val m = r.optJSONArray("m") ?: JSONArray()
    val items = (0 until m.length()).mapNotNull { i ->
        val msg = m.optJSONObject(i) ?: return@mapNotNull null
        val id = msg.opt("id")?.toString() ?: return@mapNotNull null
        val e = msg.optJSONArray("e")
        val from = e?.let { list -> (0 until list.length()).mapNotNull { list.optJSONObject(it) }.firstOrNull { it.optString("t") == "f" } }
        NativeInboxItem(
            id = id,
            conversationId = msg.opt("cid")?.toString()?.takeIf { it.isNotEmpty() },
            senderName = from?.optString("p", "")?.takeIf { it.isNotBlank() },
            senderAddress = from?.optString("a", "")?.takeIf { it.isNotBlank() },
            subject = msg.optString("su", "").takeIf { it.isNotBlank() },
            unread = msg.optString("f", "").contains('u'),
        )
    }
    return NativeInboxPage(items, r.optBoolean("more", false))
}

/**
 * A Zimbra item id as the number the cursor compares, or `null` for one that is not a plain
 * non-negative integer (an item of another mailbox, `accountId:id`) - the page's `itemNumber`.
 */
fun nativeItemNumber(id: String): Long? =
    if (id.isNotEmpty() && id.length <= 18 && id.all { it in '0'..'9' }) id.toLong() else null

/** The cursor (`mailWatchCursor.ts`): the mailbox, and the highest inbox id already considered. */
data class NativeCursor(val account: String, val highest: Long)

/**
 * The cursor of [raw] for [account], or `null` (a baseline is taken) when absent, unreadable, of
 * another version, or of another mailbox - the page's `readMailWatchCursor`, on the SAME file.
 */
fun nativeCursorOf(raw: String?, account: String): NativeCursor? {
    if (raw == null) return null
    val o = try { JSONObject(raw) } catch (_: Exception) { return null }
    if (o.opt("v") != CURSOR_VERSION) return null
    val stored = o.opt("account") as? String ?: return null
    val highest = when (val h = o.opt("highest")) {
        is Int -> h.toLong()
        is Long -> h
        else -> return null
    }
    if (highest < 0 || stored != nativeAddress(account)) return null
    return NativeCursor(stored, highest)
}

/** The cursor's text, byte for byte what the page's `JSON.stringify({v, account, highest})` writes. */
fun nativeCursorText(cursor: NativeCursor): String =
    "{\"v\":$CURSOR_VERSION,\"account\":${JSONObject.quote(nativeAddress(cursor.account))},\"highest\":${cursor.highest}}"

/** Where reading one page of the delta leaves it. */
data class NativeDeltaStep(
    /** The items above the cursor on this page, in the page's order. */
    val above: List<NativeInboxItem>,
    /** An id at or below the cursor was met: nothing older is new (the ids only grow). */
    val proven: Boolean,
    /** The id to read the next page after, or `null` when the read ends here. */
    val nextAfter: String?,
)

/** One page of the delta against [cursor] - the loop body of the page's `readNewInboxMail`. */
fun nativeDeltaStep(page: NativeInboxPage, cursor: NativeCursor): NativeDeltaStep {
    val above = mutableListOf<NativeInboxItem>()
    var proven = false
    for (item in page.items) {
        val n = nativeItemNumber(item.id) ?: continue
        if (n <= cursor.highest) {
            proven = true
            break
        }
        above += item
    }
    val nextAfter = if (proven || !page.more) null else page.items.lastOrNull()?.id
    return NativeDeltaStep(above, proven, nextAfter)
}

/** The baseline of a first page: its first NUMERIC id, or 0 for an empty inbox. */
fun nativeBaselineOf(page: NativeInboxPage): Long =
    page.items.firstNotNullOfOrNull { nativeItemNumber(it.id) } ?: 0L

/** The highest id of [above] over [cursor]: what the cursor becomes once they are considered. */
fun nativeNextHighest(cursor: NativeCursor, above: List<NativeInboxItem>): Long =
    above.mapNotNull { nativeItemNumber(it.id) }.fold(cursor.highest) { top, n -> maxOf(top, n) }

/** The page's `retryDelayMs`: 2 s, doubling, at most 5 min. A RATE bound only. */
fun nativeRetryDelayMs(failures: Int): Long {
    val exp = (failures - 1).coerceIn(0, 20)
    return minOf(300_000L, 2_000L shl exp)
}

/** The localized words a native notice needs, read from the app's resources by the caller. */
data class NativeNoticeTexts(val unknownSender: String, val noSubject: String, val publicTitle: String)

/**
 * The notice of one new mail - the page's `mailNotice`: the sender's name, else the address, else
 * "unknown"; the subject, else "(no subject)"; never the body; the conversation's link, else the
 * inbox. `null` for an id of another mailbox (never shown, as on the page); a failure when the
 * link allowlist refuses the conversation id ([mailNoticeOf]) - logged by the caller, never bent.
 */
fun nativeNoticeOf(item: NativeInboxItem, texts: NativeNoticeTexts): Result<MailNotice>? {
    val n = nativeItemNumber(item.id) ?: return null
    val link = item.conversationId?.let { "fr.emse.canari://mail/$it" } ?: "fr.emse.canari://mail"
    return mailNoticeOf(
        n,
        item.senderName ?: item.senderAddress ?: texts.unknownSender,
        item.subject ?: texts.noSubject,
        texts.publicTitle,
        link,
    )
}

/**
 * THE SEALED COPY'S RECORD (lot 4b). The plaintext the Keystore key seals: the mailbox and its
 * password, never anything else. The Canari account is the file's name and the seal's associated
 * data ([nativeVaultAad]), so a file copied under another account's name does not open.
 */
data class NativeVaultRecord(val account: String, val password: String)

/** The file of [userId]'s sealed copy in `mail_watch/`, or `null` for an id outside the allowlist
 *  (`is_wipeable_account_id` in `storage.rs` - refused, never sanitised). Rust erases the same name. */
fun nativeVaultFileName(userId: String): String? {
    val ok = userId.isNotEmpty() && userId.length <= 255 &&
        userId.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it in "_-.@" }
    return if (ok) "vault_$userId.bin" else null
}

/** The account a `vault_<id>.bin` file name is for, or `null` for any other name. */
fun nativeVaultUserOf(fileName: String): String? {
    if (!fileName.startsWith("vault_") || !fileName.endsWith(".bin")) return null
    val id = fileName.removePrefix("vault_").removeSuffix(".bin")
    return id.takeIf { nativeVaultFileName(it) == fileName }
}

/** The seal's associated data: the record opens only as [userId]'s. */
fun nativeVaultAad(userId: String): ByteArray = "canari-mail-vault:v1:$userId".toByteArray(Charsets.UTF_8)

fun nativeVaultPlaintext(record: NativeVaultRecord): ByteArray =
    JSONObject().put("account", nativeAddress(record.account)).put("password", record.password).toString().toByteArray(Charsets.UTF_8)

fun nativeVaultRecordOf(plaintext: ByteArray): NativeVaultRecord? {
    val o = try { JSONObject(String(plaintext, Charsets.UTF_8)) } catch (_: Exception) { return null }
    val account = o.optString("account", "").takeIf { it.isNotBlank() } ?: return null
    val password = o.optString("password", "").takeIf { it.isNotEmpty() } ?: return null
    return NativeVaultRecord(account, password)
}
