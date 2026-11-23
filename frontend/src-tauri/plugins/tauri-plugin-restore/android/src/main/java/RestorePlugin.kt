package app.tauri.restore

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.CancellationSignal
import android.util.Log
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreateRestoreCredentialRequest
import androidx.credentials.CreateRestoreCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetRestoreCredentialOption
import androidx.credentials.RestoreCredential
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.restorecredential.E2eeUnavailableException
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val TAG = "CanariRestore"

/**
 * Android's Restore Credentials API for WP-RESTORE-1 (docs/wiki/account-restore.md).
 *
 * A restore key is a WebAuthn key the platform keeps in the phone's Google backup and hands back,
 * on a NEW phone, to the same app restored from that backup. The server registered it against one
 * session; presenting it moves that session here (a transfer: the old phone is signed out).
 *
 * The callback API, not the coroutine one: the Tauri `Invoke` is resolved from the callback, and
 * nothing here needs a scope of its own.
 */
@TauriPlugin
class RestorePlugin(private val activity: Activity) : Plugin(activity) {
    private val credentialManager by lazy { CredentialManager.create(activity) }

    @InvokeArg
    class RequestArgs {
        lateinit var requestJson: String
    }

    /**
     * Creates this install's restore key (replacing any previous one) from the server's
     * registration options, asking for the cloud backup first.
     *
     * A phone that cannot encrypt its backup end to end refuses the cloud backup with
     * [E2eeUnavailableException]. The key is then created WITHOUT it - it still moves by a
     * device-to-device transfer - and the answer says so (`cloudBackup: false`), which the server
     * stores so the rate of this path is one GROUP BY. Logged as an error: the reader of the log
     * must see that this phone's key will not survive a lost phone.
     */
    @Command
    fun createRestoreCredential(invoke: Invoke) {
        val args = invoke.parseArgs(RequestArgs::class.java)
        Log.d(TAG, "create: asking for a restore key with cloud backup")
        create(invoke, args.requestJson, cloudBackup = true)
    }

    private fun create(invoke: Invoke, requestJson: String, cloudBackup: Boolean) {
        val request = CreateRestoreCredentialRequest(requestJson, cloudBackup)
        credentialManager.createCredentialAsync(
            activity,
            request,
            CancellationSignal(),
            activity.mainExecutor,
            object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
                override fun onResult(result: CreateCredentialResponse) {
                    val response = result as? CreateRestoreCredentialResponse
                    if (response == null) {
                        Log.e(TAG, "create: the platform answered ${result.type}, not a restore credential")
                        invoke.reject("createRestoreCredential: unexpected response type ${result.type}")
                        return
                    }
                    Log.d(TAG, "create: restore key created (cloudBackup=$cloudBackup)")
                    val answer = JSObject()
                    answer.put("responseJson", response.responseJson)
                    answer.put("cloudBackup", cloudBackup)
                    invoke.resolve(answer)
                }

                override fun onError(e: CreateCredentialException) {
                    if (cloudBackup && e is E2eeUnavailableException) {
                        Log.e(TAG, "create: no end-to-end encrypted backup on this phone - creating the key WITHOUT cloud backup; it will not survive a lost phone")
                        create(invoke, requestJson, cloudBackup = false)
                        return
                    }
                    Log.e(TAG, "create: refused (${e.type}): ${e.message}") // log-safe: a Credential Manager refusal in the platform's own words; it never quotes the request
                    invoke.reject("createRestoreCredential failed (${e.type}): ${e.message}")
                }
            }
        )
    }

    /**
     * Signs the server's assertion options with the restored key. A phone with no key is an
     * ANSWER (`absent: true`), never a rejection: a fresh install with nothing restored is the
     * ordinary case, and the frontend must not file it beside a broken provider.
     */
    @Command
    fun getRestoreCredential(invoke: Invoke) {
        val args = invoke.parseArgs(RequestArgs::class.java)
        Log.d(TAG, "get: asking for the restored key")
        val request = GetCredentialRequest(listOf(GetRestoreCredentialOption(args.requestJson)))
        credentialManager.getCredentialAsync(
            activity,
            request,
            CancellationSignal(),
            activity.mainExecutor,
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) {
                    val credential = result.credential
                    if (credential !is RestoreCredential) {
                        Log.e(TAG, "get: the platform answered ${credential.type}, not a restore credential")
                        invoke.reject("getRestoreCredential: unexpected credential type ${credential.type}")
                        return
                    }
                    Log.d(TAG, "get: restored key found and signed")
                    val answer = JSObject()
                    answer.put("absent", false)
                    answer.put("responseJson", credential.authenticationResponseJson)
                    invoke.resolve(answer)
                }

                override fun onError(e: GetCredentialException) {
                    if (e is NoCredentialException) {
                        Log.d(TAG, "get: no restore key on this phone")
                        val answer = JSObject()
                        answer.put("absent", true)
                        invoke.resolve(answer)
                        return
                    }
                    Log.e(TAG, "get: refused (${e.type}): ${e.message}") // log-safe: a Credential Manager refusal in the platform's own words; it never quotes the request
                    invoke.reject("getRestoreCredential failed (${e.type}): ${e.message}")
                }
            }
        )
    }

    /** Deletes this install's restore key, locally and from the backup. */
    @Command
    fun clearRestoreCredential(invoke: Invoke) {
        Log.d(TAG, "clear: deleting the restore key")
        val request = ClearCredentialStateRequest(ClearCredentialStateRequest.TYPE_CLEAR_RESTORE_CREDENTIAL)
        credentialManager.clearCredentialStateAsync(
            request,
            CancellationSignal(),
            activity.mainExecutor,
            object : CredentialManagerCallback<Void?, ClearCredentialException> {
                override fun onResult(result: Void?) {
                    Log.d(TAG, "clear: done")
                    invoke.resolve()
                }

                override fun onError(e: ClearCredentialException) {
                    Log.e(TAG, "clear: refused (${e.type}): ${e.message}") // log-safe: a Credential Manager refusal in the platform's own words; it never quotes the request
                    invoke.reject("clearRestoreCredential failed (${e.type}): ${e.message}")
                }
            }
        )
    }

    /**
     * The WebAuthn origin(s) Credential Manager puts in this install's `clientDataJSON`:
     * `android:apk-key-hash:` + base64url (no padding) of the SHA-256 of the certificate that signs
     * THIS APK. The server accepts only the origins `ANDROID_APP_LINK_SHA256` names (the Play
     * app-signing key), so an APK signed otherwise - the release asset sideloaded with `adb`, signed
     * by the upload key - would have every key it mints refused. Read here so the frontend knows that
     * BEFORE it mints one, instead of learning it from a refusal (docs/wiki/account-restore.md).
     *
     * The CURRENT signer: every content signer when the APK has several, otherwise the last entry of
     * the rotation history (index 0 is the original certificate, the last the one signing now).
     *
     * With it, the INSTALLER (`installingPackageName`, null for `adb` / `pm install`): the frontend
     * skips registration only for an install that did not come from Play. A Play install always
     * registers and lets the server judge, so a wrong read here can never silently cost a real user
     * their restore key - it is accused at error instead.
     */
    @Command
    fun signingOrigins(invoke: Invoke) {
        try {
            val pm = activity.packageManager
            val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(
                    activity.packageName,
                    PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong())
                )
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            }
            val signing = info.signingInfo
            if (signing == null) {
                Log.e(TAG, "signingOrigins: the package manager answered no signing info")
                invoke.reject("signingOrigins: no signing info")
                return
            }
            val certs = if (signing.hasMultipleSigners()) {
                signing.apkContentsSigners.toList()
            } else {
                signing.signingCertificateHistory.takeLast(1)
            }
            val origins = JSArray()
            for (cert in certs) origins.put(ApkKeyHash.origin(cert.toByteArray()))
            // A separate try: the installer is a hint for the frontend's skip, the origins are the
            // fact. An installer the platform will not name reads as unknown (null), which the
            // frontend treats as "not Play" only for an origin the estate does not list.
            val installer = try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    pm.getInstallSourceInfo(activity.packageName).installingPackageName
                } else {
                    @Suppress("DEPRECATION")
                    pm.getInstallerPackageName(activity.packageName)
                }
            } catch (e: Exception) {
                Log.e(TAG, "signingOrigins: installer unreadable (${e.javaClass.simpleName}) - answered as unknown")
                null
            }
            Log.d(TAG, "signingOrigins: ${certs.size} signer(s), installer known: ${installer != null}")
            val answer = JSObject()
            answer.put("origins", origins)
            // JSONObject drops a null value: an absent key reads as null on the Rust side.
            if (installer != null) answer.put("installer", installer)
            invoke.resolve(answer)
        } catch (e: Exception) {
            Log.e(TAG, "signingOrigins: unreadable (${e.javaClass.simpleName})")
            invoke.reject("signingOrigins failed (${e.javaClass.simpleName})")
        }
    }
}
