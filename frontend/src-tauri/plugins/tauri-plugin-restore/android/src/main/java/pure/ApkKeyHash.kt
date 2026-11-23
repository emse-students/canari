package app.tauri.restore

import java.security.MessageDigest
import java.util.Base64

/**
 * The WebAuthn origin Credential Manager writes into an Android app's `clientDataJSON` - pure, so a
 * JVM test pins it against the server's form (`RestoreOriginTest`, over
 * `libs/contracts/restore-apk-key-hash.cases.json`; no Android import allowed in this directory).
 *
 * `android:apk-key-hash:` + base64url WITHOUT padding of the SHA-256 of the signing certificate's
 * DER. The server derives the same string from `ANDROID_APP_LINK_SHA256` (`apkKeyHashOrigin`); if
 * the two forms ever drifted, the client would decide against an origin the server never sees.
 */
object ApkKeyHash {
    const val PREFIX = "android:apk-key-hash:"

    /** The origin of a certificate, from its DER encoding. */
    fun origin(certDer: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(certDer)
        return PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
    }
}
