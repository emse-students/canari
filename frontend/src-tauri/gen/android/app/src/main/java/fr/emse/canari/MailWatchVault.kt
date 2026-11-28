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
import java.io.IOException
import java.security.KeyStore
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.crypto.AEADBadTagException
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
 * password, the Canari sign-out, the switch off, D8 and the account deletion - AND, on Android, the
 * bridge's `forget` ([NativeMailWatcher.forget]: the erase and the stop of every native run as ONE op).
 * The erasures HERE ([erase]) are that op's and the native run's own discoveries (a refused password,
 * a closed account) - the same file name ([nativeVaultFileName]), so all remove the same thing.
 *
 * ARM AND ERASE ARE ORDERED (review I3): both run on ONE executor ([ops]), and an erase bumps a
 * generation an arm captured when it was SENT ([armGeneration]) - an arm queued before an erase, or
 * racing it, finds the generation moved and seals nothing.
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

    /** The ONE thread arms, erases and forgets run on, in the order they were sent. */
    val ops: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "canari-mail-vault") }

    private val generationLock = Any()
    private var generation = 0L

    /** The generation an arm sent NOW carries: [arm] refuses it once an erase came after. */
    fun armGeneration(): Long = synchronized(generationLock) { generation }

    /** The shared cursor file (`cursor_<id>.json`, the page's too: `commands/mail_watch.rs`). */
    fun cursorFile(context: Context, userId: String): File = File(dir(context), "cursor_$userId.json")

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
    fun arm(context: Context, userId: String, record: NativeVaultRecord, sentAt: Long): Boolean = synchronized(generationLock) {
        if (sentAt != generation) {
            Log.i(TAG, "arm refused: a forget came after it was sent")
            return false
        }
        sealUnderLock(context, userId, record)
    }

    private fun sealUnderLock(context: Context, userId: String, record: NativeVaultRecord): Boolean {
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
     * Opens [armed]'s copy, or `null`. A copy that can NEVER open is REMOVED and logged: a failed
     * authentication tag (another account's file, a key replaced), a missing Keystore key, a truncated
     * file or an unreadable record. Anything else (a read error, a Keystore busy) leaves the file: the
     * next sign-in tries again (review minor 5).
     */
    fun open(armed: Armed): NativeVaultRecord? {
        val bytes = try {
            armed.file.readBytes()
        } catch (e: IOException) {
            Log.e(TAG, "the sealed copy was not read (${e.javaClass.simpleName}) - kept, retried at the next sign-in")
            return null
        }
        if (bytes.size <= IV_BYTES) return removeUnopenable(armed, "truncated")
        return try {
            val key = existingKey() ?: return removeUnopenable(armed, "no key")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, bytes, 0, IV_BYTES))
            cipher.updateAAD(nativeVaultAad(armed.userId))
            nativeVaultRecordOf(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES))
                ?: removeUnopenable(armed, "unreadable record")
        } catch (_: AEADBadTagException) {
            removeUnopenable(armed, "authentication failed")
        } catch (e: Exception) {
            Log.e(TAG, "the sealed copy did not open (${e.javaClass.simpleName}) - kept, retried at the next sign-in")
            null
        }
    }

    private fun removeUnopenable(armed: Armed, why: String): NativeVaultRecord? {
        val gone = armed.file.delete()
        Log.e(TAG, "the sealed copy can never open ($why) - removed: $gone") // log-safe: a fixed reason word and a boolean
        return null
    }

    /**
     * Erases [userId]'s copy, or EVERY copy when `null` (a remote revocation does not know the
     * account), and bumps the generation so an arm sent before it seals nothing. [alsoCursor]: the
     * account is gone (D8), its cursor goes too. Idempotent.
     */
    fun erase(context: Context, userId: String?, alsoCursor: Boolean): Unit = synchronized(generationLock) {
        generation++
        val files = dir(context).listFiles().orEmpty().filter { f ->
            val owner = nativeVaultUserOf(f.name)
            owner != null && (userId == null || owner == userId)
        }
        for (f in files) {
            if (f.delete()) Log.i(TAG, "a sealed copy is erased")
            else Log.e(TAG, "a sealed copy was NOT erased")
        }
        if (alsoCursor && userId != null) {
            val c = cursorFile(context, userId)
            if (c.exists() && !c.delete()) Log.e(TAG, "the closed account's cursor was NOT erased")
        }
        Log.i(TAG, "erase done: ${files.size} copies, cursor too: $alsoCursor") // log-safe: a count and a boolean
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
