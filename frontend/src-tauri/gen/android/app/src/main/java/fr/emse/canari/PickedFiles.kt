package fr.emse.canari

import android.app.Activity
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.ValueCallback
import androidx.core.content.FileProvider
import fr.emse.canari.share.ShareRules
import fr.emse.canari.share.SharedFileName
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/**
 * What the WebView's file chooser (`<input type="file">`, wry's `RustWebChromeClient`) hands the
 * page: a COPY of each picked stream in this app's cache, never the picker's own `content://` URI.
 *
 * WHY (P1 of 1.8.1, measured on the Mi 9T, Android 16, 2026-11-26). The WebView builds a picked
 * `File` from the length the URI's provider STATES (`OpenableColumns.SIZE`) and reads exactly that
 * many bytes. The "Telechargements" provider still states 0 for logs Canari saved before #3028,
 * while the disk holds every byte: picked in the composer, `canari-log-...-20261016-1312.txt`
 * (2 147 637 bytes on disk and in MediaStore) came back as a `File` of size 0 that read 0 bytes,
 * and a member's log export was queued with zero bytes. Whatever a provider states, a stream read
 * to its end is the file: so each pick is copied here, read to EOF exactly as `IncomingShare`
 * copies a share, and the page gets our own FileProvider's URI for the copy, whose stated size is
 * the copy's real length.
 *
 * A pick that cannot be copied (not `content://`, one of our own providers, a grant the member gave
 * Canari, unreadable, a non-video over `ShareRules.pickCeiling`) is handed over as an EMPTY file of
 * its name: the page's pick-time read (`ownPickedFile.ts`) refuses an empty file with the
 * member-facing "could not be read" banner, so the refusal is SAID, and never queued. A video has no
 * ceiling here: its encoder reads it by ranges, and the composer always took a clip of any length.
 *
 * The copies live in `cache/picked_inbox/<pick id>/<index>/<name>` and are deleted with the next process
 * (`sweepOnce`, from `MainActivity.onCreate`, before any page can hold one): within a process the
 * page may still be reading one (a video's encoder runs after the pick), so nothing is deleted
 * under it.
 */
object PickedFiles {
    /** A pick over `ShareRules.pickCeiling`: typed, so the line names it without a message. */
    private class PickTooLarge : Exception()

    private const val TAG = "PickedFiles"
    private const val INBOX_DIR = "picked_inbox"
    private val copier = Executors.newSingleThreadExecutor()

    /** Set once the inbox has been swept in this process (`sweepOnce`). */
    @Volatile
    private var sweptThisProcess = false

    /**
     * Copies every picked URI in `picked` and answers `callback` on the UI thread with the copies'
     * URIs (in the same order). `null` (a cancelled picker) is answered at once, unchanged.
     */
    fun deliver(activity: Activity, picked: Array<Uri?>?, callback: ValueCallback<Array<Uri?>?>) {
        if (picked == null || picked.isEmpty()) {
            callback.onReceiveValue(picked)
            return
        }
        Log.i(TAG, "${picked.size} pick(s) to copy before the page reads them")
        copier.execute {
            val answer: Array<Uri?>? = try {
                copyAll(activity, picked)
            } catch (e: Exception) {
                // Nothing usable could be made: the page gets nothing, and the line accuses.
                Log.e(TAG, "the picks could not be copied: ${e.javaClass.simpleName}")
                null
            }
            activity.runOnUiThread { callback.onReceiveValue(answer) }
        }
    }

    private fun copyAll(context: Context, picked: Array<Uri?>): Array<Uri?> {
        val dir = File(File(context.cacheDir, INBOX_DIR), UUID.randomUUID().toString())
        if (!dir.mkdirs()) throw IllegalStateException("the pick directory could not be made")
        val heldGrants = context.contentResolver.persistedUriPermissions.map { it.uri.toString() }
        val authority = "${context.packageName}.fileprovider"
        return Array(picked.size) { index ->
            val uri = picked[index] ?: return@Array null
            val copy = copyOne(context, uri, dir, index, heldGrants)
            FileProvider.getUriForFile(context, authority, copy)
        }
    }

    /**
     * Copies one pick to its end into `dir` and returns the copy - an EMPTY file of the same name
     * when it is refused or unreadable, which the page refuses at the pick and says so.
     */
    private fun copyOne(context: Context, uri: Uri, dir: File, index: Int, heldGrants: List<String>): File {
        val resolver = context.contentResolver
        val mime = resolver.getType(uri) ?: "application/octet-stream"
        val stated = statedSize(context, uri)
        // ONE DIRECTORY PER PICK, the name untouched: the page names the file it sends after the
        // copy's own name (the FileProvider's display name), so no prefix may reach it.
        val slot = File(dir, index.toString())
        if (!slot.mkdirs()) throw IllegalStateException("the pick's slot could not be made")
        val target = File(slot, SharedFileName.sanitise(displayName(context, uri), mime))
        val refusal = when {
            uri.scheme != "content" -> "scheme '${uri.scheme}' is not content://"
            ShareRules.isOwnAuthority(uri.authority, context.packageName) -> "the authority is this app's own"
            ShareRules.coveredByHeldGrant(uri.toString(), heldGrants) -> "it falls under a grant the member gave Canari"
            else -> null
        }
        if (refusal != null) {
            Log.w(TAG, "pick $index refused: $refusal - handed over empty, the page refuses it")
            target.writeBytes(ByteArray(0))
            return target
        }
        val ceiling = ShareRules.pickCeiling(mime)
        var total = 0L
        try {
            resolver.openInputStream(uri).use { input ->
                if (input == null) throw IllegalStateException("the provider returned no stream")
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        if (ceiling != null && total > ceiling) throw PickTooLarge()
                        output.write(buffer, 0, read)
                    }
                }
            }
        } catch (e: Exception) {
            val why = if (e is PickTooLarge) "$mime over ${(ceiling ?: 0L) / 1024 / 1024} MB" else e.javaClass.simpleName
            Log.w(TAG, "pick $index not copied ($why) - handed over empty, the page refuses it")
            target.writeBytes(ByteArray(0))
            return target
        }
        // THE STATED SIZE AGAINST THE BYTES READ: the WebView would have read `stated`, so a
        // difference is exactly the loss this copy prevents - said at a level that accuses.
        when {
            stated == null -> Log.w(TAG, "pick $index copied: $mime, $total bytes (its provider states no size)")
            stated != total -> Log.e(TAG, "pick $index copied: $mime, $total bytes, but its provider states $stated")
            else -> Log.d(TAG, "pick $index copied: $mime, $total bytes")
        }
        return target
    }

    /** Deletes every copy an earlier process left: once per process, before any page holds one. */
    @Synchronized
    fun sweepOnce(context: Context) {
        if (sweptThisProcess) return
        sweptThisProcess = true
        val inbox = File(context.cacheDir, INBOX_DIR)
        val left = inbox.listFiles().orEmpty()
        if (left.isEmpty()) return
        Log.i(TAG, "sweeping ${left.size} pick(s) left by an earlier process")
        for (entry in left) {
            if (!entry.deleteRecursively()) Log.w(TAG, "a pick left by an earlier process was not entirely deleted")
        }
    }

    private fun statedSize(context: Context, uri: Uri): Long? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null
        }
    } catch (e: Exception) {
        Log.w(TAG, "a pick's stated size is unreadable: ${e.javaClass.simpleName}")
        null
    }

    private fun displayName(context: Context, uri: Uri): String? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (e: Exception) {
        Log.w(TAG, "a pick's display name is unreadable: ${e.javaClass.simpleName}")
        null
    }
}
