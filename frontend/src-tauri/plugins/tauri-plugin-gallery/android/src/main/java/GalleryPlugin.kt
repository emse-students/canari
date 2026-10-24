package app.tauri.gallery

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.Executors

private const val TAG = "GalleryPlugin"
private const val ALBUM = "Canari"
private const val STORAGE_ALIAS = "storage"

/**
 * The phone's gallery for CanaReels (C6): a saved reel lands in `Movies/Canari`, where the system
 * gallery and Google Photos list it.
 *
 * ANDROID 10+ NEEDS NO PERMISSION to ADD a file to the shared collection: `MediaStore` takes it
 * through the app's own content resolver, marked pending until its bytes are in. ANDROID 9 (the
 * app's `minSdk` 28) has no `RELATIVE_PATH`, so the file is copied into the public Movies directory
 * and scanned - which needs `WRITE_EXTERNAL_STORAGE`, declared for API 28 only and asked for at the
 * moment of the save. A refusal there is an outcome (`denied`), never a failure.
 */
@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = STORAGE_ALIAS)
    ]
)
class GalleryPlugin(private val activity: Activity) : Plugin(activity) {
    @InvokeArg
    class SaveVideoArgs {
        lateinit var path: String
        lateinit var name: String
    }

    @Command
    fun saveVideo(invoke: Invoke) {
        val args = invoke.parseArgs(SaveVideoArgs::class.java)
        Log.d(TAG, "saveVideo ${args.name} (sdk ${Build.VERSION.SDK_INT})")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            offMainThread { saveThroughMediaStore(invoke, args) }
            return
        }
        if (getPermissionState(STORAGE_ALIAS) == PermissionState.GRANTED) {
            offMainThread { saveToPublicMovies(invoke, args) }
        } else {
            requestPermissionForAlias(STORAGE_ALIAS, invoke, "storagePermissionAnswered")
        }
    }

    @PermissionCallback
    private fun storagePermissionAnswered(invoke: Invoke) {
        if (getPermissionState(STORAGE_ALIAS) != PermissionState.GRANTED) {
            Log.d(TAG, "saveVideo: storage permission refused")
            invoke.resolve(JSObject().put("status", "denied"))
            return
        }
        val args = invoke.parseArgs(SaveVideoArgs::class.java)
        offMainThread { saveToPublicMovies(invoke, args) }
    }

    /**
     * A reel is tens of MB: copying it on the thread that draws the app would freeze the screen for
     * the length of the copy. `Invoke.resolve` / `reject` may be called from any thread.
     */
    private fun offMainThread(work: () -> Unit) {
        Thread(work, "canari-gallery-save").start()
    }

    /** Android 10+: a pending MediaStore row, the bytes, then the row published. */
    private fun saveThroughMediaStore(invoke: Invoke, args: SaveVideoArgs) {
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, args.name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/$ALBUM")
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        val collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = resolver.insert(collection, values)
        if (uri == null) {
            Log.e(TAG, "saveVideo: MediaStore refused the row")
            invoke.reject("MediaStore refused the row")
            return
        }
        try {
            val out = resolver.openOutputStream(uri) ?: throw IllegalStateException("no output stream")
            out.use { stream -> File(args.path).inputStream().use { it.copyTo(stream) } }
            values.clear()
            values.put(MediaStore.Video.Media.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            Log.d(TAG, "saveVideo: saved as $uri")
            invoke.resolve(JSObject().put("status", "saved"))
        } catch (e: Exception) {
            // A half-written row must not stay in the gallery as a broken video.
            resolver.delete(uri, null, null)
            Log.e(TAG, "saveVideo failed", e)
            invoke.reject("saveVideo failed: ${e.message}")
        }
    }

    /** Android 9: a copy in the public Movies directory, then a scan so the gallery lists it. */
    private fun saveToPublicMovies(invoke: Invoke, args: SaveVideoArgs) {
        try {
            @Suppress("DEPRECATION")
            val dir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES),
                ALBUM
            )
            if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("cannot create $dir")
            val target = File(dir, args.name)
            File(args.path).copyTo(target, overwrite = true)
            MediaScannerConnection.scanFile(activity, arrayOf(target.absolutePath), arrayOf("video/mp4"), null)
            Log.d(TAG, "saveVideo: saved to ${target.absolutePath}")
            invoke.resolve(JSObject().put("status", "saved"))
        } catch (e: Exception) {
            Log.e(TAG, "saveVideo failed", e)
            invoke.reject("saveVideo failed: ${e.message}")
        }
    }

    @InvokeArg
    class ShareTextArgs {
        lateinit var text: String
    }

    @InvokeArg
    class ShareFileArgs {
        lateinit var path: String
        lateinit var mime: String
    }

    /** The system share sheet on a text: a message, a link. */
    @Command
    fun shareText(invoke: Invoke) {
        val args = invoke.parseArgs(ShareTextArgs::class.java)
        Log.d(TAG, "shareText: ${args.text.length} chars")
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, args.text)
        openChooser(invoke, send)
    }

    /**
     * The system share sheet on a file in the cache's `share_out/`, the one cache directory the app's
     * FileProvider exposes (`res/xml/file_paths.xml`). The receiving app gets a READ grant on that
     * one `content://` URI, carried by the intent's ClipData so the chooser passes it on.
     */
    @Command
    fun shareFile(invoke: Invoke) {
        val args = invoke.parseArgs(ShareFileArgs::class.java)
        val uri = try {
            FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", File(args.path))
        } catch (e: IllegalArgumentException) {
            Log.e(TAG, "shareFile: the file is outside the FileProvider's paths", e)
            invoke.reject("shareFile: the file is not shareable")
            return
        }
        // Not the URI: it ends with the member's attachment name.
        Log.d(TAG, "shareFile: ${args.mime}")
        val send = Intent(Intent.ACTION_SEND)
            .setType(args.mime)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = ClipData.newRawUri(null, uri)
        openChooser(invoke, send)
    }

    /** Opens the chooser on `send`; resolved once it is shown, whatever the member then picks. */
    private fun openChooser(invoke: Invoke, send: Intent) {
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent.createChooser(send, null))
                invoke.resolve()
            } catch (e: Exception) {
                Log.e(TAG, "the share sheet did not open", e)
                invoke.reject("the share sheet did not open: ${e.message}")
            }
        }
    }

    @InvokeArg
    class ShareTargetArg {
        lateinit var id: String
        lateinit var label: String
        lateinit var link: String
    }

    @InvokeArg
    class PublishShareTargetsArgs {
        lateinit var targets: Array<ShareTargetArg>
    }

    /**
     * Share suggestions (lot S5) are binder calls into the shortcut service: off the UI thread, and
     * on ONE thread, so a clear issued after a publish is applied after it.
     */
    private val shareTargetsThread = Executors.newSingleThreadExecutor()

    /** Replaces the conversations Android's share sheet suggests (`ShareTargets.publish`). */
    @Command
    fun publishShareTargets(invoke: Invoke) {
        val args = invoke.parseArgs(PublishShareTargetsArgs::class.java)
        Log.d(TAG, "publishShareTargets: ${args.targets.size} target(s)")
        val targets = args.targets.map { ShareTargets.Target(it.id, it.label, it.link) }
        shareTargetsThread.execute {
            try {
                val published = ShareTargets.publish(activity, targets)
                invoke.resolve(JSObject().put("present", published.present).put("leftover", published.leftover))
            } catch (e: Exception) {
                Log.e(TAG, "publishShareTargets failed", e)
                invoke.reject("publishShareTargets failed: ${e.message}")
            }
        }
    }

    /** Removes every conversation this app suggested to the share sheet (`ShareTargets.clear`). */
    @Command
    fun clearShareTargets(invoke: Invoke) {
        Log.d(TAG, "clearShareTargets")
        shareTargetsThread.execute {
            try {
                val removed = ShareTargets.clear(activity)
                invoke.resolve(JSObject().put("removed", removed))
            } catch (e: Exception) {
                Log.e(TAG, "clearShareTargets failed", e)
                invoke.reject("clearShareTargets failed: ${e.message}")
            }
        }
    }

    /**
     * Removes every `chat_<group>` conversation shortcut the message notifications published
     * (`ConversationShortcuts.clear`) - at sign-out, so no conversation name or face of this
     * account stays with the system for the next one.
     */
    @Command
    fun clearConversationShortcuts(invoke: Invoke) {
        Log.d(TAG, "clearConversationShortcuts")
        shareTargetsThread.execute {
            try {
                val removed = ConversationShortcuts.clear(activity)
                invoke.resolve(JSObject().put("removed", removed))
            } catch (e: Exception) {
                Log.e(TAG, "clearConversationShortcuts failed", e)
                invoke.reject("clearConversationShortcuts failed: ${e.message}")
            }
        }
    }

    /** This app's page in the system settings, where a refused permission is given back. */
    @Command
    fun openAppSettings(invoke: Invoke) {
        Log.d(TAG, "openAppSettings")
        try {
            val intent = Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", activity.packageName, null)
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
            invoke.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "openAppSettings failed", e)
            invoke.reject("openAppSettings failed: ${e.message}")
        }
    }
}
