package fr.emse.canari

import android.app.NotificationManager
import android.app.PendingIntent
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
        /** ID de la notification "ouvrez l'app" affichée après 3 échecs consécutifs. */
        private const val FAILURE_NOTIF_ID = 9997

        const val PREFS_WORKER = "canari_worker_prefs"
        const val KEY_FAILED   = "mls_bg_failed"

        /**
         * Réinitialise le flag d'échec persistant - à appeler depuis [MainActivity.onResume]
         * dès que l'utilisateur ouvre l'app, pour que les prochains FCM enqueueront à nouveau.
         */
        fun resetFailureFlag(context: Context) {
            context.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_FAILED, false).apply()
            Log.d(TAG, "resetFailureFlag: flag réinitialisé")
        }

        /** Affiche une notification invitant l'utilisateur à ouvrir l'app pour débloquer la sync. */
        private fun showWorkerFailureNotification(ctx: Context) {
            val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            CanariApplication.ensureChannels(manager)
            val launchIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
            val pi = PendingIntent.getActivity(
                ctx, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val notif = NotificationCompat.Builder(ctx, CanariFirebaseMessagingService.CHANNEL_MESSAGES)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Canari - Synchronisation en attente")
                .setContentText("Ouvrez l'app pour recevoir vos messages chiffrés.")
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(pi)
                .build()
            manager.notify(FAILURE_NOTIF_ID, notif)
            Log.w(TAG, "showWorkerFailureNotification: notification affichée")
        }
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
            applicationContext.getSharedPreferences(PREFS_WORKER, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_FAILED, true).apply()
            showWorkerFailureNotification(applicationContext)
            return Result.failure()
        }
        Log.d(TAG, "doWork: démarrage (attempt $runAttemptCount)")

        val ctx = MlsContextLoader.loadPushContext(applicationContext)
        if (ctx == null) {
            Log.e(TAG, "doWork: push_context.json manquant ou invalide → failure")
            return Result.failure()
        }
        val filesDir = MlsContextLoader.tauriDataDir(applicationContext).also { it.mkdirs() }.absolutePath

        // Acquire lock BEFORE reading mls.bin: FCM threads write mls.bin concurrently
        // (nativeDecryptMessage). Reading outside the lock risks JNI-processing stale state.
        // tryLock throws InterruptedException under Android memory pressure - must be caught.
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