package fr.emse.canari

import android.content.Context
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import androidx.work.Worker
import androidx.work.WorkerParameters

class MlsBackgroundWorker(context: Context, workerParams: WorkerParameters) :
    Worker(context, workerParams) {

    companion object {
        const val TAG = "CanariWorker"
        /** ID de la notification foreground affichée quand le worker s'exécute en mode expedited. */
        private const val FOREGROUND_NOTIF_ID = 9998
    }

    // Pont JNI spécifique pour le traitement de la file d'attente (Welcome, etc.)
    external fun nativeProcessBackgroundTasks(filesDir: String, stateBytes: ByteArray, pin: String, userId: String, deviceId: String): Boolean

    /**
     * Requis pour les workers expedited : fournit la notification foreground affichée
     * si Android décide de promouvoir le worker en ForegroundService (rare en pratique).
     */
    override fun getForegroundInfo(): ForegroundInfo {
        val notification = NotificationCompat.Builder(
            applicationContext, CanariFirebaseMessagingService.CHANNEL_MESSAGES
        )
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Canari")
            .setContentText("Synchronisation des messages…")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        return ForegroundInfo(FOREGROUND_NOTIF_ID, notification)
    }

    override fun doWork(): Result {
        if (runAttemptCount >= 3) {
            Log.e(TAG, "doWork: max retries reached, giving up")
            return Result.failure()
        }
        Log.d(TAG, "doWork: démarrage (attempt $runAttemptCount)")

        val ctx = MlsContextLoader.loadPushContext(applicationContext)
        if (ctx == null) {
            Log.e(TAG, "doWork: push_context.json manquant ou invalide → failure")
            return Result.failure()
        }
        val filesDir = applicationContext.filesDir.parentFile!!.absolutePath

        // Acquire lock BEFORE reading mls.bin: FCM threads write mls.bin concurrently
        // (nativeDecryptMessage). Reading outside the lock risks JNI-processing stale state.
        // tryLock throws InterruptedException under Android memory pressure — must be caught.
        val lockAcquired = try {
            MlsStateLock.LOCK.tryLock(15, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Log.e(TAG, "doWork: thread interrompu pendant tryLock: ${e.message}")
            return Result.retry()
        }
        if (!lockAcquired) {
            Log.w(TAG, "doWork: MlsStateLock non acquis après 15s → retry")
            return Result.retry()
        }
        return try {
            val stateBytes = MlsContextLoader.loadMlsState(applicationContext)
            if (stateBytes == null) {
                Log.e(TAG, "doWork: mls.bin absent → failure")
                return Result.failure()
            }
            Log.d(TAG, "doWork: état MLS=${stateBytes.size} octets, filesDir=$filesDir")
            val success = nativeProcessBackgroundTasks(filesDir, stateBytes, ctx.pin, ctx.userId, ctx.deviceId)
            if (success) {
                Log.d(TAG, "doWork: nativeProcessBackgroundTasks → succès")
                Result.success()
            } else {
                Log.w(TAG, "doWork: nativeProcessBackgroundTasks → false, retry")
                Result.retry()
            }
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "doWork: librairie native non chargée → retry: ${e.message}")
            Result.retry()
        } catch (e: Exception) {
            Log.e(TAG, "doWork: exception inattendue → failure: ${e.message}")
            Result.failure()
        } finally {
            MlsStateLock.LOCK.unlock()
        }
    }

}