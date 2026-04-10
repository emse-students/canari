package fr.emse.canari

import android.app.Application

/**
 * Application custom chargée AVANT tout composant Android (y compris les services FCM).
 * Son unique rôle : charger la bibliothèque native Rust mines_app_lib pour que
 * CanariFirebaseMessagingService puisse appeler nativeDecryptMessage() même
 * quand l'activité principale n'est pas démarrée.
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
    }
}
