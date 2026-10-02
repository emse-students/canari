package app.tauri.gallery

import android.Manifest
import android.app.Activity
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
import java.io.File

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
