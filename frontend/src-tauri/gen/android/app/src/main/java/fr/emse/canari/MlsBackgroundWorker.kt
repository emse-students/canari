package fr.emse.canari

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.File

class MlsBackgroundWorker(context: Context, workerParams: WorkerParameters) :
    Worker(context, workerParams) {

    // Pont JNI spécifique pour le traitement de la file d'attente (Welcome, etc.)
    external fun nativeProcessBackgroundTasks(stateBytes: ByteArray, pin: String): Boolean

    override fun doWork(): Result {
        val stateBytes = loadMlsState() ?: return Result.failure()
        val pin = loadPin() ?: return Result.failure()

        return try {
            val success = nativeProcessBackgroundTasks(stateBytes, pin)
            if (success) {
                Result.success()
            } else {
                // Si Rust retourne false, on dit au WorkManager de réessayer plus tard
                Result.retry()
            }
        } catch (e: UnsatisfiedLinkError) {
            // La librairie Rust n'est pas encore chargée par l'OS
            // On demande à WorkManager de réessayer
            Result.retry()
        } catch (e: Exception) {
            Result.failure()
        }
    }

    private fun loadMlsState(): ByteArray? {
        val file = File(applicationContext.filesDir, "mls.bin")
        return if (file.exists()) try { file.readBytes() } catch (_: Exception) { null } else null
    }

    private fun loadPin(): String? {
        val file = File(applicationContext.filesDir, "push_context.json")
        if (!file.exists()) return null
        return try {
            JSONObject(file.readText()).optString("pin").takeIf { it.isNotEmpty() }
        } catch (_: Exception) { null }
    }
}