package fr.emse.canari

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Log
import androidx.core.content.pm.ShortcutManagerCompat
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
    private const val EPOCH_FILE = "share_epoch"

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
        val target = suggestedTarget(intent)
        Log.i(TAG, "share received: action=${intent.action} type=${intent.type} text=${text.length} chars, ${uris.size} stream(s), suggestion=${target != null}")
        if (text.isEmpty() && uris.isEmpty()) {
            Log.w(TAG, "share carried neither text nor a stream - ignored")
            return
        }
        val appContext = context.applicationContext
        // READ WHEN THE CAPTURE STARTS, not when it ends: a copy still running when the member signs
        // out belongs to the session that ended, and its manifest must say so (`share_epoch`,
        // advanced by every sign-out - see `commands/handoff.rs`).
        // Unreadable is read as 0, which is STALE: the file exists only once a sign-out advanced it.
        val epoch = shareEpoch(appContext) ?: 0L
        Thread {
            try {
                if (runCapture(appContext, text, uris, intent.type, epoch, target)) onReady()
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
    private fun runCapture(context: Context, text: String, uris: List<Uri>, intentType: String?, epoch: Long, target: String?): Boolean {
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
            // A SHARE THAT KEPT NO FILE KEEPS NO FOLDER: no manifest entry names it, so nothing would
            // delete it while the process lives - a text share left one empty folder each (Mi 9T,
            // 2026-10-27). One an older build left goes with the next process (`sweepOrphansOnce`).
            if (files.length() == 0) {
                deleteDir(dir, if (text.isEmpty()) "share $shareId kept nothing" else "share $shareId is text only")
                if (text.isEmpty()) return reportRefusals(context, refused, epoch)
            }
            val payload = JSONObject()
                .put("id", shareId)
                .put("epoch", epoch)
                .put("text", text)
                .put("files", files)
                .put("refused", refused)
            if (target != null) payload.put("target", target)
            // CLAIMED, NOT PEEKED AT: the older manifest is renamed away first, so the page cannot drain
            // it between this capture reading its id and deleting its copies.
            val replaced = claimPending(context)
            // A NEWER SESSION'S SHARE IS NEVER REPLACED BY AN OLDER ONE: captures queue on this lock in
            // no set order, so one started before a sign-out can run after one started since. The
            // older is dropped - it could only ever be discarded as stale by the page.
            if (replaced != null && replaced.optLong("epoch", 0) > epoch) {
                writePending(context, replaced)
                deleteDir(dir, "share $shareId from a signed-out session (epoch $epoch)")
                return false
            }
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
     * share still waiting when both come from the SAME session (epoch) - which stays as it was - or
     * handed over alone. A count never crosses a sign-out: it would tell one account that another
     * shared something, or be discarded with a stale share and tell nobody.
     */
    private fun reportRefusals(context: Context, refused: Int, epoch: Long): Boolean {
        if (refused == 0) return false
        val waiting = claimPending(context)
        val waitingEpoch = waiting?.optLong("epoch", 0) ?: epoch
        if (waiting != null && waitingEpoch > epoch) {
            writePending(context, waiting)
            Log.w(TAG, "$refused refusal(s) from a signed-out session (epoch $epoch) dropped")
            return false
        }
        if (waiting != null && waitingEpoch < epoch) {
            // The waiting share is from a signed-out session: stale, so it goes, and these stand alone.
            waiting.optString("id").takeIf { it.isNotEmpty() }?.let { id ->
                deleteDir(File(inboxDir(context), id), "stale share $id (epoch $waitingEpoch)")
            }
        }
        val payload = waiting?.takeIf { waitingEpoch == epoch }
            ?.put("refused", waiting.optInt("refused", 0) + refused)
            ?: JSONObject().put("id", UUID.randomUUID().toString()).put("epoch", epoch).put("text", "")
                .put("files", JSONArray()).put("refused", refused)
        Log.w(TAG, "a share kept nothing: $refused refusal(s) reported")
        return writePending(context, payload)
    }

    /**
     * The share epoch the page's sign-outs advance (`share_epoch` in the Tauri data directory, written
     * whole by a rename); 0 before the first sign-out, null when unreadable (said, at the level that
     * accuses: the page's drain refuses every share until it reads again - `commands/handoff.rs`).
     */
    private fun shareEpoch(context: Context): Long? {
        val file = File(MlsContextLoader.tauriDataDir(context), EPOCH_FILE)
        if (!file.exists()) return 0
        return try {
            file.readText().trim().toLong()
        } catch (e: Exception) {
            Log.e(TAG, "the share epoch is unreadable: ${e.message}")
            null
        }
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

    /**
     * The id of the manifest waiting to be drained, if it is from the CURRENT session. One from a
     * session that has since signed out (a copy that finished after the sign-out, with the page not
     * mounted to drain it) is claimed and dropped here, so its copies go with the sweep instead of
     * waiting, on disk, for the next account to drain them.
     */
    private fun currentPendingShareId(context: Context): String? {
        val waiting = try {
            val file = pendingFile(context)
            if (file.exists()) JSONObject(file.readText()) else return null
        } catch (e: Exception) {
            Log.w(TAG, "the waiting share manifest is unreadable: ${e.message}")
            return null
        }
        val current = shareEpoch(context)
        if (current == null || waiting.optLong("epoch", 0) < current) {
            claimPending(context)
            Log.i(TAG, "a waiting share from a signed-out session dropped (epoch ${waiting.optLong("epoch", 0)} < $current)")
            return null
        }
        return waiting.optString("id").takeIf { it.isNotEmpty() }
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
     * Deletes every copy in the inbox that the waiting manifest of the current session does not name
     * (`currentPendingShareId`) - once per process,
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
        val keep = currentPendingShareId(context)
        val orphans = inboxDir(context).listFiles().orEmpty().filter { it.name != keep }
        if (orphans.isEmpty()) return
        Log.i(TAG, "sweeping ${orphans.size} share(s) left by an earlier process")
        for (entry in orphans) deleteDir(entry, "orphan share")
    }

    /**
     * The conversation suggestion the member picked in the share sheet (sharing lot S5), as the
     * shortcut id the page published (`c:<conversation id>`), or null. Only a HINT: the page
     * preselects it only if the signed-in account holds that conversation.
     */
    private fun suggestedTarget(intent: Intent): String? {
        val id = intent.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID) ?: return null
        if (id.startsWith("c:") && id.length in 3..200) return id
        Log.w(TAG, "a shortcut id not of the suggestion shape was ignored")
        return null
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
