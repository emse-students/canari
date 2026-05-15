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

    init {
        try {
            System.loadLibrary("mines_app_lib")
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "init: impossible de charger mines_app_lib: ${e.message}")
        }
    }

    // Pont JNI spécifique pour le traitement de la file d'attente (Welcome, etc.)
    external fun nativeProcessBackgroundTasks(filesDir: String, stateBytes: ByteArray, pin: String): Boolean

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
        val pin = loadPin()
        if (pin == null) {
            Log.e(TAG, "doWork: PIN absent (push_context.json manquant ou invalide) → failure")
            return Result.failure()
        }
        val filesDir = applicationContext.filesDir.absolutePath
        Log.d(TAG, "doWork: état MLS=${stateBytes.size} octets, filesDir=$filesDir")

        return try {
            val success = nativeProcessBackgroundTasks(filesDir, stateBytes, pin)
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
        }
    }

    private fun loadMlsState(): ByteArray? {
        val file = File(applicationContext.filesDir, "mls.bin")
        if (!file.exists()) return null
        return try { file.readBytes() } catch (_: Exception) { null }
    }

    private fun loadPin(): String? {
        val file = File(applicationContext.filesDir, "push_context.json")
        if (!file.exists()) return null
        return try {
            JSONObject(file.readText()).optString("pin").takeIf { it.isNotEmpty() }
        } catch (_: Exception) { null }
    }
}