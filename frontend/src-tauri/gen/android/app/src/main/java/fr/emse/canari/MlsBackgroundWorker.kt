package fr.emse.canari

import android.content.Context
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.File

class MlsBackgroundWorker(context: Context, workerParams: WorkerParameters) :
    Worker(context, workerParams) {

    companion object {
        const val TAG = "CanariWorker"
    }

    // Pont JNI spécifique pour le traitement de la file d'attente (Welcome, etc.)
    external fun nativeProcessBackgroundTasks(filesDir: String, stateBytes: ByteArray, pin: String, userId: String, deviceId: String): Boolean

    override fun doWork(): Result {
        if (runAttemptCount >= 3) {
            Log.e(TAG, "doWork: max retries reached, giving up")
            return Result.failure()
        }
        Log.d(TAG, "doWork: démarrage (attempt $runAttemptCount)")
        val stateBytes = loadMlsState()
        if (stateBytes == null) {
            Log.e(TAG, "doWork: mls.bin absent → failure")
            return Result.failure()
        }
        val ctx = loadPushContext()
        if (ctx == null) {
            Log.e(TAG, "doWork: push_context.json manquant ou invalide → failure")
            return Result.failure()
        }
        val filesDir = applicationContext.filesDir.parentFile!!.absolutePath
        Log.d(TAG, "doWork: état MLS=${stateBytes.size} octets, filesDir=$filesDir")

        if (!MlsStateLock.LOCK.tryLock(15, java.util.concurrent.TimeUnit.SECONDS)) {
            Log.w(TAG, "doWork: MlsStateLock non acquis après 15s → retry")
            return Result.retry()
        }
        return try {
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

    private fun loadMlsState(): ByteArray? {
        val file = File(applicationContext.filesDir.parentFile, "mls.bin")
        if (!file.exists()) return null
        return try { file.readBytes() } catch (_: Exception) { null }
    }

    private data class PushContext(val pin: String, val userId: String, val deviceId: String)

    private fun loadPushContext(): PushContext? {
        val file = File(applicationContext.filesDir.parentFile, "push_context.json")
        if (!file.exists()) return null
        return try {
            val j = JSONObject(file.readText())
            PushContext(
                pin      = j.optString("pin").takeIf      { it.isNotEmpty() } ?: return null,
                userId   = j.optString("userId").takeIf   { it.isNotEmpty() } ?: return null,
                deviceId = j.optString("deviceId").takeIf { it.isNotEmpty() } ?: return null,
            )
        } catch (_: Exception) { null }
    }
}