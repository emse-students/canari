package fr.emse.canari

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Demande la permission de notification nativement sur Android 13+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }
    }

    // Par défaut sur Android ≥ API 21, les cookies tiers sont bloqués dans le WebView.
    // L'app fait des requêtes fetch() avec credentials:'include' depuis tauri://localhost
    // vers canari-emse.fr — sans ce flag, le cookie canari_refresh n'est jamais stocké
    // ni renvoyé, ce qui brise la persistance de session après chaque redémarrage.
    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        // Transparent background lets the Activity windowBackground show through while
        // SvelteKit hydrates, eliminating the ~1s black flash on startup.
        webView.setBackgroundColor(Color.TRANSPARENT)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onStop() {
        super.onStop()
        CookieManager.getInstance().flush()
    }
}