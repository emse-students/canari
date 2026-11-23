package fr.emse.canari

import app.tauri.restore.ApkKeyHash
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The origin the app computes for its own signing certificate (`ApkKeyHash.origin`, what
 * `RestorePlugin.signingOrigins` returns) must be, byte for byte, the origin the server derives from
 * `ANDROID_APP_LINK_SHA256` (`apkKeyHashOrigin`). Both read `libs/contracts/restore-apk-key-hash.cases.json`:
 * this side hashes `derHex`, the server's `restore-config.spec.ts` converts `fingerprint`, and both
 * must give `origin` (docs/wiki/account-restore.md).
 */
class RestoreOriginTest {
    private fun hexBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { i -> hex.substring(2 * i, 2 * i + 2).toInt(16).toByte() }

    @Test
    fun `computes the shared contract's origin from the certificate DER`() {
        val file = File(System.getProperty("user.dir"), "../../../libs/contracts/restore-apk-key-hash.cases.json")
        val cases = JSONObject(file.readText()).getJSONArray("cases")
        assertTrue("the contract holds no case", cases.length() > 0)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(c.getString("name"), c.getString("origin"), ApkKeyHash.origin(hexBytes(c.getString("derHex"))))
        }
    }
}
