package fr.emse.canari

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Log
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
 * a directory `take_picked_file` is allowed to read and delete. The copy runs off the UI thread: a
 * shared video would otherwise freeze the launch.
 *
 * Nothing is SENT from here. The page asks the member where to send it, and the composer is what
 * sends - a share is only ever a draft.
 */
object IncomingShare {
    private const val TAG = "IncomingShare"
    private const val PENDING_FILE = "pending_share.json"
    private const val INBOX_DIR = "shared_inbox"

    /** At most this many files are kept from one share; the rest are counted as refused. */
    const val MAX_FILES = 10

    /**
     * Per-file ceiling for the COPY, above the server's own (a video is re-encoded on the device
     * before upload, so its shared size is not its sent size). A larger stream is dropped, not cut.
     */
    const val MAX_FILE_BYTES = 512L * 1024 * 1024

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
                discardUndrainedShare(appContext)
                val shareId = UUID.randomUUID().toString()
                val dir = File(File(appContext.cacheDir, INBOX_DIR), shareId).also { it.mkdirs() }
                val files = JSONArray()
                var refused = 0
                for ((index, uri) in uris.withIndex()) {
                    if (index >= MAX_FILES) {
                        refused++
                        continue
                    }
                    val copied = copyStream(appContext, uri, dir, index, intent.type)
                    if (copied == null) refused++ else files.put(copied)
                }
                val payload = JSONObject()
                    .put("id", shareId)
                    .put("text", text)
                    .put("files", files)
                    .put("refused", refused)
                File(MlsContextLoader.tauriDataDir(appContext), PENDING_FILE).writeText(payload.toString())
                Log.i(TAG, "share $shareId ready: ${files.length()} file(s), $refused refused")
                onReady()
            } catch (e: Exception) {
                Log.e(TAG, "share capture failed: ${e.message}", e)
            }
        }.start()
    }

    /**
     * A share the page never drained is REPLACED by a newer one, and its copies go with it: the
     * member shared again, and only the latest is offered. A share the page already drained has no
     * pending file any more, so the files it is still reading are never touched.
     */
    private fun discardUndrainedShare(context: Context) {
        val pending = File(MlsContextLoader.tauriDataDir(context), PENDING_FILE)
        if (!pending.exists()) return
        try {
            val id = JSONObject(pending.readText()).optString("id")
            // The id names a directory under OUR inbox only; anything else is not ours to delete.
            if (id.matches(Regex("[0-9a-f-]{36}"))) {
                File(File(context.cacheDir, INBOX_DIR), id).deleteRecursively()
            }
            Log.i(TAG, "an undrained share ($id) was replaced by a newer one")
        } catch (e: Exception) {
            Log.w(TAG, "undrained share unreadable, replaced anyway: ${e.message}")
        }
        pending.delete()
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
     * Copies one stream into `dir` under a sanitised name. Returns its JSON entry, or null when it
     * could not be read or exceeded [MAX_FILE_BYTES] (the partial copy is deleted).
     */
    private fun copyStream(context: Context, uri: Uri, dir: File, index: Int, intentType: String?): JSONObject? {
        if (uri.scheme != "content") {
            // A `file://` URI would let the sender name any path this app can read - including our
            // own data. Only a content provider's grant is accepted.
            Log.w(TAG, "stream $index refused: scheme '${uri.scheme}' is not content://")
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
                        if (total > MAX_FILE_BYTES) {
                            output.close()
                            target.delete()
                            Log.w(TAG, "stream $index refused: over ${MAX_FILE_BYTES / 1024 / 1024} MB")
                            return null
                        }
                        output.write(buffer, 0, read)
                    }
                }
            }
            Log.d(TAG, "stream $index copied: $mime, $total bytes")
            JSONObject().put("path", target.absolutePath).put("name", name).put("mime", mime)
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
