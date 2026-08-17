package fr.emse.canari

import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
        // The web layer reads system-bar insets via env(safe-area-inset-*) everywhere (status
        // bar, nav bar, keyboard) - without this call that only holds by luck of OS-enforced
        // edge-to-edge on Android 15+ targetSdk 35+; below that, or on OEMs that don't apply it
        // consistently (seen on a Xiaomi/HyperOS device), the nav bar sits outside the window and
        // the insets read back as zero, leaving the composer flush against the nav bar.
        enableEdgeToEdge()
        // A phone stays in portrait; a tablet is a PC here and keeps its rotation. The threshold
        // is a resource qualifier rather than a manifest attribute because
        // `android:screenOrientation` takes one literal value, which cannot serve both.
        requestedOrientation =
            if (resources.getBoolean(R.bool.canari_lock_portrait)) {
                ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            } else {
                ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
        super.onCreate(savedInstanceState)
        applyKeyboardInsets()

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

    /**
     * Shrinks the window contents by the height of the soft keyboard.
     *
     * `android:windowSoftInputMode="adjustResize"` no longer does it. Since Android 15 an
     * edge-to-edge window is never resized for the IME - the flag survives in the manifest and is
     * inert, which `dumpsys window` states outright as `EDGE_TO_EDGE_ENFORCED` next to the
     * `adjust=resize` we asked for. The composer therefore sat under the keyboard, and the page,
     * auto-scrolled by the WebView to reveal the focused field, ran past the end of its own
     * content onto the activity background. That background is visible because the WebView is
     * deliberately transparent (see `onWebViewCreate`), which is how ONE cause wore two faces: a
     * hidden composer, and a white band appearing on scroll.
     *
     * THE NAVIGATION BAR IS ALSO WITHDRAWN while the keyboard is up, and that half matters as much
     * as the padding. The web layer reserves a strip for it through `env(safe-area-inset-bottom)`,
     * which is right when the bar is at the bottom of the app and wrong the moment the keyboard is:
     * the bar is then BEHIND the keyboard, and the strip becomes an empty band the page can be
     * scrolled by, revealing the reserved footer while hiding part of the header. So the inset is
     * zeroed on the way down rather than left for CSS to guess at - "the keyboard is up" is known
     * here and nowhere else, and the status bar is deliberately untouched because it is still there.
     */
    private fun applyKeyboardInsets() {
        val content = findViewById<View>(android.R.id.content) ?: return
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            if (view.paddingBottom != ime) {
                Log.d("MainActivity", "IME inset: $ime -> content padding")
                view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, ime)
            }
            if (ime == 0) return@setOnApplyWindowInsetsListener insets
            val bars = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            WindowInsetsCompat.Builder(insets)
                .setInsets(
                    WindowInsetsCompat.Type.navigationBars(),
                    Insets.of(bars.left, bars.top, bars.right, 0)
                )
                .build()
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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Keep getIntent()/deep-link getCurrent() aligned with the notification tap intent.
        setIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        isInForeground = true
        MlsBackgroundWorker.resetFailureFlag(this)
        OutboxRetryWorker.resetFailureFlag(this)
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