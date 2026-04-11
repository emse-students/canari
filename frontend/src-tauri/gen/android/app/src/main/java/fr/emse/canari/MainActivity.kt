package fr.emse.canari

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.enableEdgeToEdge
import com.google.firebase.messaging.FirebaseMessaging

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Récupère (ou génère) le token FCM et le stocke dans SharedPreferences
    // pour que la WebView Tauri puisse le lire via invoke("get_fcm_token")
    FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
      if (task.isSuccessful) {
        val token = task.result
        val prefs = getSharedPreferences(
          CanariFirebaseMessagingService.PREFS_NAME,
          Context.MODE_PRIVATE
        )
        prefs.edit().putString(CanariFirebaseMessagingService.KEY_FCM_TOKEN, token).apply()
      }
    }

    // Demander à l'utilisateur d'exempter l'appli de l'optimisation batterie.
    // Sans cela, les OEMs (Samsung, Xiaomi…) peuvent tuer le processus FCM
    // et bloquer la réception des notifications push quand l'appli est fermée.
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
        } catch (_: Exception) {
          // Certains ROM bloquent ou ne comprennent pas cet intent — ignorer.
        }
      }
    }
  }
}
