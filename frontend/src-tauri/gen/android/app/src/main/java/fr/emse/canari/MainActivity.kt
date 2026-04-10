package fr.emse.canari

import android.content.Context
import android.content.Intent
import android.os.Bundle
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
  }
}
