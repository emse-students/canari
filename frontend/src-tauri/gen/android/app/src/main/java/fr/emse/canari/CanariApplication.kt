package fr.emse.canari

import android.app.Application
import java.io.File

/**
 * Application custom chargée AVANT tout composant Android (y compris les services FCM).
 * Rôles :
 *  1. Charger la bibliothèque native Rust mines_app_lib.
 *  2. Transférer le pushSecret depuis pending_push_secret.txt vers le Keystore Android
 *     (écrit par Tauri après enregistrement FCM, lu une seule fois puis supprimé).
 *
 * Enregistrée dans AndroidManifest.xml via android:name=".CanariApplication".
 */
class CanariApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        try {
            System.loadLibrary("mines_app_lib")
        } catch (_: UnsatisfiedLinkError) {
            // La lib n'est pas disponible sur cette architecture – les appels
            // natifs échoueront gracieusement (notification générique affichée).
        }
        processPendingPushSecret()
    }

    private fun processPendingPushSecret() {
        try {
            val file = File(filesDir, "pending_push_secret.txt")
            if (!file.exists()) return
            val secret = file.readText().trim()
            if (secret.isNotEmpty()) {
                PushSecretKeystore.store(this, secret)
            }
            file.delete()
        } catch (_: Exception) { }
    }
}
