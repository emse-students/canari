package fr.emse.canari

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import com.google.firebase.messaging.FirebaseMessaging
import java.io.File
import org.json.JSONObject

class MainActivity : TauriActivity() {
  // Référence au WebView Tauri — injectée via le hook WryActivity.onWebViewCreate()
  // avant toute navigation. Utilisée pour les appels IPC vers Rust.
  private var rustWebView: WebView? = null

  // Guards against tao JNI NullPtr("get_object_class") crash:
  // onNewIntent can fire before the Rust native runtime is ready (cold start via
  // deep link when the Activity is already in the back stack). We queue the intent
  // and re-deliver it once onWebViewCreate signals that tao is initialized.
  private var tauriReady = false
  private val pendingIntents = mutableListOf<Intent>()

  override fun onNewIntent(intent: Intent) {
    if (tauriReady) {
      super.onNewIntent(intent)
    } else {
      pendingIntents.add(intent)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    rustWebView = webView
    tauriReady = true
    pendingIntents.forEach { super.onNewIntent(it) }
    pendingIntents.clear()

    // Autorise les cookies cross-origin (canari_refresh HttpOnly) dans le WebView.
    // Android bloque les cookies tiers par défaut depuis l'API 21 ; sans ça le
    // refresh token set-cookie est ignoré depuis l'origine tauri.localhost.
    CookieManager.getInstance().setAcceptCookie(true)
    CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    
    // Deep linking is handled by Tauri's plugin-deep-link via onNewIntent (overridden above
    // with a guard to avoid JNI NullPtr crashes on cold start).

    // Récupère (ou génère) le token FCM dès le démarrage.
    // Si le token est déjà connu, il est stocké dans le fichier ET notifié au
    // frontend via la commande Tauri notify_fcm_token (→ app.emit("fcm-token")).
    FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
      if (!task.isSuccessful) return@addOnCompleteListener
      val token = task.result ?: return@addOnCompleteListener

      // Écriture locale — toujours faire ici en plus de onNewToken() pour le cas
      // où le service FCM a raté l'écriture lors d'une précédente session.
      try { File(filesDir, "fcm_token.txt").writeText(token) } catch (_: Exception) { }

      // Notifier le frontend via l'IPC Tauri officielle.
      // On encode le payload en base64 pour éviter toute injection JS.
      val json = JSONObject().put("token", token).toString()
      val b64 = Base64.encodeToString(json.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
      runOnUiThread {
        rustWebView?.evaluateJavascript(
          """(function(){
            if(!window.__TAURI_INTERNALS__)return;
            window.__TAURI_INTERNALS__.invoke(
              'notify_fcm_token',JSON.parse(atob('$b64')),null
            ).catch(function(){});
          })();""",
          null
        )
      }
    }

    // Demander l'exemption de l'optimisation batterie pour ne pas bloquer FCM.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      if (!pm.isIgnoringBatteryOptimizations(packageName)) {
        try {
          startActivity(
            Intent(
              Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
              Uri.parse("package:$packageName")
            )
          )
        } catch (_: Exception) { }
      }
    }
  }

  /**
   * FCM Token Handling — Notify frontend of Firebase Cloud Messaging token.
   * This is used for push notifications (not related to deep linking).
   */
  // (FCM handling is done in onCreate via FirebaseMessaging.getInstance().token)
}
