package fr.emse.canari

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * WHAT THE OS LETS THIS APP'S NOTIFICATIONS DO, WRITTEN FOR THE PAGE (2026-11-21).
 *
 * The page reads it through the Rust command `notification_delivery_state`
 * (`commands/notification_delivery_state.rs`, which pins the shape): one JSON snapshot in the app
 * data directory, rewritten at every launch and every return to the foreground ([MainActivity.onResume]) -
 * the moments the answer can have changed, since a switch is flipped in the system settings.
 *
 * READ-ONLY: nothing here asks the OS for a permission or opens a screen. The file name and the keys
 * are shared with the Rust module - change both together.
 */
object NotificationDeliveryState {
    private const val TAG = "NotifDeliveryState"
    private const val FILE = "notification_delivery_state.json"

    /** The messages and posts channels, by id - the two a missing notification is read from. */
    private const val CHANNEL_MESSAGES = "canari_messages_v2"
    private const val CHANNEL_POSTS = "canari_social"

    /** `NotificationManager.IMPORTANCE_*` by name; any other value is `unspecified`. */
    internal fun importanceName(importance: Int): String = when (importance) {
        NotificationManager.IMPORTANCE_NONE -> "none"
        NotificationManager.IMPORTANCE_MIN -> "min"
        NotificationManager.IMPORTANCE_LOW -> "low"
        NotificationManager.IMPORTANCE_DEFAULT -> "default"
        NotificationManager.IMPORTANCE_HIGH, NotificationManager.IMPORTANCE_MAX -> "high"
        else -> "unspecified"
    }

    private fun channelImportance(manager: NotificationManager, id: String): String {
        val channel = manager.getNotificationChannel(id) ?: return "absent"
        return importanceName(channel.importance)
    }

    /** The snapshot as the Rust command parses it. */
    fun snapshot(context: Context, rationale: Boolean): JSONObject {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val permissionGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        return JSONObject()
            .put("platform", "android")
            .put("notificationsEnabled", NotificationManagerCompat.from(context).areNotificationsEnabled())
            .put("postNotificationsGranted", permissionGranted)
            // True after a refusal the system lets us explain: with the page's own durable "prompt
            // shown" flag it tells "refused" from "never asked", which `checkSelfPermission` cannot
            // (it says DENIED before the first prompt too). Always false below Android 13.
            .put("shouldShowRationale", rationale)
            .put(
                "channels",
                JSONObject()
                    .put("messages", channelImportance(manager, CHANNEL_MESSAGES))
                    .put("posts", channelImportance(manager, CHANNEL_POSTS))
            )
            .put("isIgnoringBatteryOptimizations", power.isIgnoringBatteryOptimizations(context.packageName))
            .put("manufacturer", Build.MANUFACTURER ?: "")
    }

    private fun shouldShowRationale(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        val activity = context as? android.app.Activity ?: return false
        return activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** One thread, in order: a snapshot is a few Binder calls and a file write, never the UI thread's. */
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "canari-notif-state") }

    /**
     * Writes the snapshot OFF the main thread, then runs [onWritten] on the caller's behalf (on that
     * background thread) - the moment the page may read a fresh answer, so it is told by an event and
     * never by a clock. The rationale flag needs the activity, so it is read here, on the caller's
     * thread, and travels as an argument.
     */
    fun writeAsync(context: Context, onWritten: () -> Unit) {
        val rationale = shouldShowRationale(context)
        val app = context.applicationContext
        executor.execute { if (write(app, rationale)) onWritten() }
    }

    /** Writes the snapshot; a failure is logged and leaves the previous one (or none: unknown). */
    private fun write(context: Context, rationale: Boolean): Boolean {
        try {
            val dir = MlsContextLoader.tauriDataDir(context).also { it.mkdirs() }
            val json = snapshot(context, rationale).toString()
            val tmp = File(dir, "$FILE.tmp")
            tmp.writeText(json)
            if (!tmp.renameTo(File(dir, FILE))) {
                Log.w(TAG, "snapshot not moved into place")
                return false
            }
            return true
        } catch (e: Exception) {
            Log.w(TAG, "snapshot not written: ${e.javaClass.simpleName}") // log-safe: class name only
            return false
        }
    }
}
