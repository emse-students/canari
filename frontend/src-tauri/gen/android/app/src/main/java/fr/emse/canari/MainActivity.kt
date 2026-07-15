package fr.emse.canari

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.google.firebase.messaging.FirebaseMessaging
import java.io.File

class MainActivity : TauriActivity() {
    companion object {
        /**
         * True while the activity is in the foreground (between onResume and onPause).
         * Used by CanariFirebaseMessagingService to suppress MLS message notifications
         * when the app is open (the WebSocket has already delivered them).
         */
        @Volatile var isInForeground: Boolean = false
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)

        // Request the notification permission natively on Android 13+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }

        // Sync the FCM token to fcm_token.txt read by the Rust command get_fcm_token.
        // Needed on restart: onNewToken is not called again when the token is unchanged.
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            if (!token.isNullOrEmpty()) {
                try {
                    val dataDir = MlsContextLoader.tauriDataDir(this).also { it.mkdirs() }
                    File(dataDir, "fcm_token.txt").writeText(token)
                    getSharedPreferences(CanariFirebaseMessagingService.PREFS_NAME, MODE_PRIVATE)
                        .edit().putString(CanariFirebaseMessagingService.KEY_FCM_TOKEN, token).apply()
                    Log.i("MainActivity", "FCM token synced (${token.take(20)}…)")
                } catch (e: Exception) {
                    Log.w("MainActivity", "FCM token sync failed: ${e.message}")
                }
            }
        }
    }

    // By default on Android >= API 21, third-party cookies are blocked in the WebView.
    // The app makes fetch() requests with credentials:'include' from tauri://localhost
    // to canari-emse.fr - without this flag the canari_refresh cookie is never stored
    // nor sent back, which breaks session persistence after every restart.
    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        // Transparent background lets the Activity windowBackground show through while
        // SvelteKit hydrates, eliminating the ~1s black flash on startup.
        webView.setBackgroundColor(Color.TRANSPARENT)
    }

    override fun onResume() {
        super.onResume()
        isInForeground = true
        MlsBackgroundWorker.resetFailureFlag(this)
        // Opening the app clears lingering message notifications (read here or on another
        // device) - the visible half of cross-device read-state sync.
        CanariFirebaseMessagingService.cancelAllMessageNotifications(this)
        Log.d("MainActivity", "onResume: isInForeground=true, worker failure flag reset")
        // Migrates pending_push_secret.txt → Keystore on first foreground resume after
        // FCM registration (store_push_secret writes the file during the live session;
        // no-op after migration since processPendingPushSecret deletes the file).
        Thread {
            val app = application as? CanariApplication ?: return@Thread
            app.processPendingPushSecret()
            app.checkKeystoreHealth()
        }.start()
    }

    override fun onPause() {
        super.onPause()
        isInForeground = false
        Log.d("MainActivity", "onPause: isInForeground=false")
        CookieManager.getInstance().flush()
    }

    override fun onStop() {
        super.onStop()
        CookieManager.getInstance().flush()
    }
}