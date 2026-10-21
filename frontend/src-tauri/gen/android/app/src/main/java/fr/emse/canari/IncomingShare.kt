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

    /** Set once the inbox has been swept in this process (`sweepOrphansOnce`). */
    private var sweptThisProcess = false

    /**
     * One capture at a time: two shares arriving together would otherwise race on the pending file
     * and on which older share each replaces. The newer one simply waits and then replaces the older.
     *
     * NOTHING OLDER IS DELETED UNTIL THIS SHARE IS HANDED OVER. A capture that throws, or that keeps
     * nothing, leaves whatever came before exactly as it was - a share the page already holds keeps
     * its files, and a staging in progress is never cut.
     */
    @Synchronized
    private fun runCapture(context: Context, text: String, uris: List<Uri>, intentType: String?): Boolean {
        val shareId = UUID.randomUUID().toString()
        val dir = File(inboxDir(context), shareId).also { it.mkdirs() }
        try {
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
            if (text.isEmpty() && files.length() == 0) {
                deleteDir(dir, "share $shareId kept nothing")
                return reportRefusals(context, refused)
            }
            val payload = JSONObject()
                .put("id", shareId)
                .put("text", text)
                .put("files", files)
                .put("refused", refused)
            // CLAIMED, NOT PEEKED AT: the older manifest is renamed away first, so the page cannot drain
            // it between this capture reading its id and deleting its copies.
            val replaced = claimPending(context)
            if (!writePending(context, payload)) {
                deleteDir(dir, "share $shareId not handed over")
                if (replaced != null) writePending(context, replaced)
                return false
            }
            // Handed over: the older share nobody drained is now unreachable, and only now is it gone.
            replaced?.optString("id")?.takeIf { it.isNotEmpty() }?.let { id ->
                Log.i(TAG, "an undrained share was replaced by a newer one")
                deleteDir(File(inboxDir(context), id), "replaced share $id")
            }
            Log.i(TAG, "share $shareId ready: ${files.length()} file(s), $kept bytes, $refused refused")
            return true
        } catch (e: Exception) {
            deleteDir(dir, "share $shareId failed")
            throw e
        }
    }

    /**
     * A share that kept nothing still has refusals the member must hear about. They are added to the
     * share still waiting, if there is one - which stays as it was - or handed over alone.
     */
    private fun reportRefusals(context: Context, refused: Int): Boolean {
        if (refused == 0) return false
        val waiting = claimPending(context)
        val payload = waiting?.put("refused", waiting.optInt("refused", 0) + refused)
            ?: JSONObject().put("id", UUID.randomUUID().toString()).put("text", "")
                .put("files", JSONArray()).put("refused", refused)
        Log.w(TAG, "a share kept nothing: $refused refusal(s) reported")
        return writePending(context, payload)
    }

    private fun pendingFile(context: Context) = File(MlsContextLoader.tauriDataDir(context), PENDING_FILE)

    /**
     * Takes the manifest still waiting to be drained, if any: renamed out of the page's reach first -
     * the drain claims it the same way (`commands/handoff.rs`), so exactly one of the two gets it -
     * then read and deleted. Null when none was waiting, or it was unreadable (said).
     */
    private fun claimPending(context: Context): JSONObject? {
        val claimed = File(MlsContextLoader.tauriDataDir(context), "$PENDING_FILE.replacing")
        if (!pendingFile(context).renameTo(claimed)) return null
        return try {
            JSONObject(claimed.readText())
        } catch (e: Exception) {
            Log.w(TAG, "the waiting share manifest is unreadable: ${e.message}")
            null
        } finally {
            if (!claimed.delete()) Log.w(TAG, "the claimed manifest ${claimed.name} was not deleted")
        }
    }

    /** The id of the manifest waiting to be drained, read without claiming it. */
    private fun pendingShareId(context: Context): String? = try {
        val file = pendingFile(context)
        if (file.exists()) JSONObject(file.readText()).optString("id").takeIf { it.isNotEmpty() } else null
    } catch (e: Exception) {
        Log.w(TAG, "the waiting share manifest is unreadable: ${e.message}")
        null
    }

    /**
     * WRITTEN WHOLE OR NOT AT ALL: the page may drain at any moment (a return to the foreground), and
     * a reader catching a half-written file would drop the share as corrupt. A rename within one
     * directory is atomic, and replaces the manifest it lands on.
     */
    private fun writePending(context: Context, payload: JSONObject): Boolean {
        val target = pendingFile(context)
        val staging = File(target.parentFile, "$PENDING_FILE.tmp")
        staging.writeText(payload.toString())
        if (staging.renameTo(target)) return true
        Log.e(TAG, "the pending share file could not be renamed into place")
        if (!staging.delete()) Log.w(TAG, "the staged manifest ${staging.name} was not deleted")
        return false
    }

    private fun inboxDir(context: Context) = File(context.cacheDir, INBOX_DIR)

    private fun deleteDir(dir: File, why: String) {
        if (dir.deleteRecursively()) {
            Log.d(TAG, "$why: ${dir.name} deleted")
        } else {
            Log.w(TAG, "$why: ${dir.name} was not entirely deleted")
        }
    }

    /**
     * Deletes every copy in the inbox that the waiting manifest does not name - once per process,
     * from the first `onCreate`, before any capture.
     *
     * Then, and only then, nobody can be using them: no page is alive yet to stage a share or hold
     * one, so a copy the waiting manifest does not name belongs to a share that died with the last
     * process (drained but never staged, cancelled before its copies were deleted). While the
     * process lives, each copy is deleted by whoever ends its share - the page reading it
     * (`take_picked_file`), the page dropping it (`discard_picked_file`), or the capture that
     * replaces an undrained one.
     */
    @Synchronized
    fun sweepOrphansOnce(context: Context) {
        if (sweptThisProcess) return
        sweptThisProcess = true
        val keep = pendingShareId(context)
        val orphans = inboxDir(context).listFiles().orEmpty().filter { it.name != keep }
        if (orphans.isEmpty()) return
        Log.i(TAG, "sweeping ${orphans.size} share(s) left by an earlier process")
        for (entry in orphans) deleteDir(entry, "orphan share")
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
            Pair(
                JSONObject().put("path", target.absolutePath).put("name", name).put("mime", mime).put("size", total),
                total,
            )
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
