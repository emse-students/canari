package fr.emse.canari

import java.util.concurrent.locks.ReentrantLock

/**
 * Verrou partagé entre [CanariFirebaseMessagingService] et [MlsBackgroundWorker].
 * Garantit qu'un seul composant lit/écrit mls.bin à la fois, même si FCM et WorkManager
 * tournent en parallèle dans le même processus applicatif.
 */
object MlsStateLock {
    val LOCK = ReentrantLock()
}
