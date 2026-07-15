package fr.emse.canari

import java.util.concurrent.locks.ReentrantLock

/**
 * Lock shared between [CanariFirebaseMessagingService] and [MlsBackgroundWorker].
 * Guarantees that a single component reads/writes mls.bin at a time, even if FCM and WorkManager
 * run in parallel within the same application process.
 */
object MlsStateLock {
    val LOCK = ReentrantLock()
}
