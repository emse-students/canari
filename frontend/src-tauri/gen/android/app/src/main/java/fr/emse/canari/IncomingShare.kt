package fr.emse.canari

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Log
import fr.emse.canari.share.ShareRules
import fr.emse.canari.share.SharedFileName
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Content another app shared INTO Canari ("Partager -> Canari"), handed to the page through a file.
 *
 * WHY A FILE AND NOT A JAVASCRIPT CALL. A share usually cold-starts the app: the intent arrives in
 * `onCreate`, long before the page has loaded, and a value set with `evaluateJavascript` before
 * the page navigates is wiped by the navigation. So the share is written to `pending_share.json` in
 * the Tauri data directory, and the page drains it (`read_and_clear_pending_share`) at mount and
 * whenever `canari:incoming-share` tells a page that is already alive - the same handoff as the
 * iOS CallKit answer (`pending_call_accept.json`).
 *
 * WHY THE BYTES ARE COPIED HERE, AT ONCE. A shared `content://` URI is readable only while the
 * grant the sender gave this activity lasts, and the page reads much later (after the PIN). Each
 * stream is copied, streamed and never held whole in memory, into `cache/shared_inbox/<share id>/`,
 * a directory `take_picked_file` is allowed to read and delete, under the ceilings of `ShareRules`.
 * The copies STAY ON DISK until the member has picked a destination and the page stages them:
 * nothing is read into the WebView before that. The copy runs off the UI thread: a shared video
 * would otherwise freeze the launch.
 *
 * Nothing is SENT from here. The page asks the member where to send it, and the composer is what
 * sends - a share is only ever a draft.
 */
object IncomingShare {
    private const val TAG = "IncomingShare"
    private const val PENDING_FILE = "pending_share.json"
    private const val INBOX_DIR = "shared_inbox"

    /** Whether `intent` is a share this activity accepts. */
    fun isShare(intent: Intent?): Boolean =
        intent?.action == Intent.ACTION_SEND || intent?.action == Intent.ACTION_SEND_MULTIPLE

    /**
     * Copies the shared content in the background, writes `pending_share.json`, then calls
     * `onReady` on the copying thread so the caller can tell a live page to drain it.
     */
    fun capture(context: Context, intent: Intent, onReady: () -> Unit) {
        val text = sharedText(intent)
        val uris = sharedUris(intent)
        Log.i(TAG, "share received: action=${intent.action} type=${intent.type} text=${text.length} chars, ${uris.size} stream(s)")
        if (text.isEmpty() && uris.isEmpty()) {
            Log.w(TAG, "share carried neither text nor a stream - ignored")
            return
        }
        val appContext = context.applicationContext
        Thread {
            try {
                if (runCapture(appContext, text, uris, intent.type)) onReady()
            } catch (e: Exception) {
                Log.e(TAG, "share capture failed: ${e.message}", e)
            }
        }.start()
    }

    /**
     * One capture at a time: two shares arriving together would otherwise sweep each other's copies
     * and race on the pending file. The newer one simply waits and then replaces the older.
     */
    @Synchronized
    private fun runCapture(context: Context, text: String, uris: List<Uri>, intentType: String?): Boolean {
        sweepInbox(context)
        val shareId = UUID.randomUUID().toString()
        val dir = File(inboxDir(context), shareId).also { it.mkdirs() }
        val heldGrants = context.contentResolver.persistedUriPermissions.map { it.uri.toString() }
        val files = JSONArray()
        var refused = 0
        var kept = 0L
        for ((index, uri) in uris.withIndex()) {
            if (index >= ShareRules.MAX_FILES) {
                Log.w(TAG, "stream $index refused: past ${ShareRules.MAX_FILES} files")
                refused++
                continue
            }
            val ceiling = ShareRules.nextFileCeiling(kept)
            val copied = if (ceiling <= 0) {
                Log.w(TAG, "stream $index refused: the share already holds ${ShareRules.MAX_TOTAL_BYTES / 1024 / 1024} MB")
                null
            } else {
                copyStream(context, uri, dir, index, intentType, ceiling, heldGrants)
            }
            if (copied == null) {
                refused++
            } else {
                kept += copied.second
                files.put(copied.first)
            }
        }
        val payload = JSONObject()
            .put("id", shareId)
            .put("text", text)
            .put("files", files)
            .put("refused", refused)
        // WRITTEN WHOLE OR NOT AT ALL: the page may drain at any moment (a return to the foreground),
        // and a reader catching a half-written file would drop the share as corrupt. A rename within
        // one directory is atomic.
        val dataDir = MlsContextLoader.tauriDataDir(context)
        val staging = File(dataDir, "$PENDING_FILE.tmp")
        staging.writeText(payload.toString())
        if (!staging.renameTo(File(dataDir, PENDING_FILE))) {
            staging.delete()
            dir.deleteRecursively()
            Log.e(TAG, "share $shareId not handed over: the pending file could not be renamed into place")
            return false
        }
        Log.i(TAG, "share $shareId ready: ${files.length()} file(s), $kept bytes, $refused refused")
        return true
    }

    private fun inboxDir(context: Context) = File(context.cacheDir, INBOX_DIR)

    /**
     * Empties the inbox before a new share is copied into it. A newer share REPLACES whatever came
     * before - undrained (its pending file goes too), drained but never staged (cancelled, or its
     * conversation never opened), or left behind by a corrupt manifest or a failed read - so nothing
     * in the inbox survives the next share, and nothing outside it is ever deleted from here.
     */
    private fun sweepInbox(context: Context) {
        val pending = File(MlsContextLoader.tauriDataDir(context), PENDING_FILE)
        if (pending.exists()) {
            Log.i(TAG, "an undrained share was replaced by a newer one")
            pending.delete()
        }
        val leftovers = inboxDir(context).listFiles().orEmpty()
        if (leftovers.isNotEmpty()) Log.d(TAG, "sweeping ${leftovers.size} earlier share(s) from the inbox")
        for (entry in leftovers) entry.deleteRecursively()
    }

    private fun sharedText(intent: Intent): String {
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
        val body = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        // A browser shares the page title as the subject and the URL as the text: both are kept,
        // unless the text already carries the subject.
        return when {
            subject.isEmpty() -> body
            body.isEmpty() -> subject
            body.contains(subject) -> body
            else -> "$subject\n$body"
        }
    }

    @Suppress("DEPRECATION")
    private fun sharedUris(intent: Intent): List<Uri> {
        if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            val list = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
            }
            return list.orEmpty().filterNotNull()
        }
        val single = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        }
        return listOfNotNull(single)
    }

    /**
     * Copies one stream into `dir` under a sanitised name. Returns its JSON entry and its size, or
     * null when it was refused: not a `content://` URI, one of our own providers or a grant we hold,
     * unreadable, or larger than `ceiling` (the partial copy is deleted).
     */
    private fun copyStream(
        context: Context,
        uri: Uri,
        dir: File,
        index: Int,
        intentType: String?,
        ceiling: Long,
        heldGrants: List<String>,
    ): Pair<JSONObject, Long>? {
        if (uri.scheme != "content") {
            // A `file://` URI would let the sender name any path this app can read - including our
            // own data. Only a content provider's grant is accepted.
            Log.w(TAG, "stream $index refused: scheme '${uri.scheme}' is not content://")
            return null
        }
        if (ShareRules.isOwnAuthority(uri.authority, context.packageName)) {
            Log.w(TAG, "stream $index refused: authority '${uri.authority}' is this app's own")
            return null
        }
        if (ShareRules.coveredByHeldGrant(uri.toString(), heldGrants)) {
            Log.w(TAG, "stream $index refused: it falls under a grant the member gave Canari, not the sender")
            return null
        }
        val resolver = context.contentResolver
        val mime = resolver.getType(uri) ?: intentType?.takeIf { !it.endsWith("/*") } ?: "application/octet-stream"
        val name = SharedFileName.sanitise(displayName(context, uri), mime)
        // The index prefix keeps two streams with the same name apart on disk; the page is told the
        // name alone.
        val target = File(dir, "${index}_$name")
        return try {
            var total = 0L
            resolver.openInputStream(uri).use { input ->
                if (input == null) {
                    Log.w(TAG, "stream $index refused: the provider returned no stream")
                    return null
                }
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        if (total > ceiling) {
                            output.close()
                            target.delete()
                            Log.w(TAG, "stream $index refused: over its ceiling of ${ceiling / 1024 / 1024} MB")
                            return null
                        }
                        output.write(buffer, 0, read)
                    }
                }
            }
            Log.d(TAG, "stream $index copied: $mime, $total bytes")
            Pair(JSONObject().put("path", target.absolutePath).put("name", name).put("mime", mime), total)
        } catch (e: Exception) {
            target.delete()
            Log.w(TAG, "stream $index refused: ${e.message}")
            null
        }
    }

    private fun displayName(context: Context, uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    } catch (e: Exception) {
        Log.w(TAG, "display name unreadable: ${e.message}")
        null
    }
}
