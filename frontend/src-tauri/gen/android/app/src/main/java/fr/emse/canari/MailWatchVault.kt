package fr.emse.canari

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import fr.emse.canari.mail.NativeVaultRecord
import fr.emse.canari.mail.nativeVaultAad
import fr.emse.canari.mail.nativeVaultFileName
import fr.emse.canari.mail.nativeVaultPlaintext
import fr.emse.canari.mail.nativeVaultRecordOf
import fr.emse.canari.mail.nativeVaultUserOf
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * THE NATIVE WATCHER'S SEALED COPY OF THE MAILBOX PASSWORD (lot 4b, owner decision 2026-11-28,
 * docs/wiki/mail-client.md D6).
 *
 * The page keeps the remembered password sealed under the device key, which a page alone opens. A
 * watcher that restarts at boot has no page, so it holds its OWN copy, sealed here:
 *
 * - **the key** is an Android Keystore AES-256-GCM key ([KEY_ALIAS]): generated inside the keystore
 *   (in the TEE on a phone that has one), never exportable, and with NO user-authentication
 *   requirement - the watch must run with the screen locked, so it cannot ask for a fingerprint;
 * - **the ciphertext** is `mail_watch/vault_<account id>.bin` in the app's data dir, which is
 *   CREDENTIAL-ENCRYPTED storage: it exists for this process only after the user's first unlock
 *   following a boot ([DirectBoot]), so the watch starts after that unlock and never before;
 * - **the associated data** names the Canari account ([nativeVaultAad]): a file renamed under
 *   another account does not open.
 *
 * It exists only while the user ticked "remember" AND turned the switch on: the page arms it then
 * ([arm], the bridge's `arm`), and every forget path erases it through ONE function, Rust's
 * `erase_vault` (`commands/mail_watch.rs`): a mail sign-out, an unticked "remember", a refused
 * password, the Canari sign-out, the switch off, D8 and the account deletion. The one erasure HERE is
 * the native watcher's own discovery that the server refuses the password ([eraseRefused]) - the same
 * file name ([nativeVaultFileName]), so both remove the same thing.
 *
 * ONE COPY AT A TIME: arming an account removes any other account's copy, so at most one native
 * watcher has anything to run.
 */
object MailWatchVault {
    private const val TAG = "MailWatchVault"
    private const val KEY_ALIAS = "canari_mail_watch_vault_key"
    private const val DIR = "mail_watch"
    private const val GCM_TAG_BITS = 128
    private const val IV_BYTES = 12

    private fun dir(context: Context): File = File(MlsContextLoader.tauriDataDir(context), DIR)

    /** The sealed copy that is there: its account id and its file. */
    data class Armed(val userId: String, val file: File)

    /**
     * The ONE armed copy, by its file alone (nothing is decrypted), or `null`. `null` too while the
     * storage is still locked: not "nothing armed", "cannot look yet" - logged as such.
     */
    fun armed(context: Context): Armed? {
        if (!DirectBoot.storageReadable(context)) {
            Log.i(TAG, "storage still locked (before the first unlock) - the sealed copy cannot be looked for yet")
            return null
        }
        val files = dir(context).listFiles().orEmpty()
            .mapNotNull { f -> nativeVaultUserOf(f.name)?.let { Armed(it, f) } }
        if (files.size > 1) Log.e(TAG, "${files.size} sealed copies - arming should have left one; the first is used")
        return files.firstOrNull()
    }

    /** Whether [userId]'s copy is still there: checked by the native watcher before each cursor write and notice. */
    fun stillArmed(context: Context, userId: String): Boolean {
        val name = nativeVaultFileName(userId) ?: return false
        return File(dir(context), name).exists()
    }

    /**
     * Seals [record] for [userId], replacing any copy (this account's or another's). Atomic: a
     * sibling file renamed over it. `false` (logged) when it was not written.
     */
    fun arm(context: Context, userId: String, record: NativeVaultRecord): Boolean {
        val name = nativeVaultFileName(userId)
        if (name == null) {
            Log.e(TAG, "arm refused: an account id outside the allowlist")
            return false
        }
        if (!DirectBoot.storageReadable(context)) {
            Log.e(TAG, "arm refused: storage still locked")
            return false
        }
        return try {
            val d = dir(context).also { it.mkdirs() }
            d.listFiles().orEmpty().filter { nativeVaultUserOf(it.name) != null && it.name != name }.forEach {
                if (it.delete()) Log.i(TAG, "another account's sealed copy removed: one copy at a time")
                else Log.e(TAG, "another account's sealed copy NOT removed")
            }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            cipher.updateAAD(nativeVaultAad(userId))
            val sealed = cipher.iv + cipher.doFinal(nativeVaultPlaintext(record))
            val tmp = File(d, "$name.tmp")
            tmp.writeBytes(sealed)
            if (!tmp.renameTo(File(d, name))) {
                tmp.delete()
                Log.e(TAG, "arm failed: the sealed copy was not renamed into place")
                return false
            }
            Log.i(TAG, "the mailbox password is sealed for the native watcher")
            true
        } catch (e: Exception) {
            Log.e(TAG, "arm failed: ${e.javaClass.simpleName}")
            false
        }
    }

    /**
     * Opens [armed]'s copy, or `null`. A copy that does not open (a lost Keystore key, a file of
     * another account) is REMOVED and logged: it can never open again, and a watcher must not retry it.
     */
    fun open(context: Context, armed: Armed): NativeVaultRecord? {
        return try {
            val bytes = armed.file.readBytes()
            if (bytes.size <= IV_BYTES) throw IllegalStateException("a truncated sealed copy")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, existingKey() ?: throw IllegalStateException("no key"), GCMParameterSpec(GCM_TAG_BITS, bytes, 0, IV_BYTES))
            cipher.updateAAD(nativeVaultAad(armed.userId))
            nativeVaultRecordOf(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES))
                ?: throw IllegalStateException("an unreadable record")
        } catch (e: Exception) {
            Log.e(TAG, "the sealed copy does not open (${e.javaClass.simpleName}) - removed")
            armed.file.delete()
            null
        }
    }

    /** The server refuses the sealed password: the copy is useless, and retrying it at every boot
     *  would only send a wrong password again. Removed; the page asks for the password next time. */
    fun eraseRefused(context: Context, userId: String) {
        val name = nativeVaultFileName(userId) ?: return
        val f = File(dir(context), name)
        if (!f.exists() || f.delete()) Log.i(TAG, "the refused sealed copy is erased")
        else Log.e(TAG, "the refused sealed copy was NOT erased")
    }

    private fun existingKey(): SecretKey? {
        val ks = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
        return ks.getKey(KEY_ALIAS, null) as? SecretKey
    }

    /** The key, created when absent. Called only with the storage readable ([arm]). */
    private fun getOrCreateKey(): SecretKey {
        existingKey()?.let { return it }
        val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            // No user authentication: the watch runs with the screen locked (see the class comment).
            .setUserAuthenticationRequired(false)
            .build()
        Log.i(TAG, "creating the sealed copy's Keystore key")
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .also { it.init(spec) }
            .generateKey()
    }
}
