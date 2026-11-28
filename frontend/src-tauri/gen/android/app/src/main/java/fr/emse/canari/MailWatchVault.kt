package fr.emse.canari

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import fr.emse.canari.mail.NativeVaultOrder
import fr.emse.canari.mail.NativeVaultRecord
import fr.emse.canari.mail.nativeCopyFileUserOf
import fr.emse.canari.mail.nativePersistentFileName
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
 * ARM, FORGET, CLAIM AND RELEASE ARE ORDERED (review I3 and its second round): all run on ONE
 * executor ([ops]) in the order their messages arrived, and [order] ([NativeVaultOrder]) makes a
 * forget win over every arm sent BEFORE it and over none sent after it, and keeps the run's own
 * erase from removing a copy written after the one it opened.
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

    /** The ONE thread arms, forgets, claims and releases run on, in the order they arrived. */
    val ops: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "canari-mail-vault") }

    /** The order of the copy's writes; every file write and erase runs inside it. */
    val order = NativeVaultOrder()

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

    /**
     * Whether a copy is armed WITH the persistent-watch choice on: what resumes the native watch at
     * boot and after a kill - never the copy's existence alone (the push path needs the copy too).
     */
    fun persistentArmed(context: Context): Boolean {
        val armed = armed(context) ?: return false
        val name = nativePersistentFileName(armed.userId) ?: return false
        return File(dir(context), name).exists()
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
    fun arm(context: Context, userId: String, record: NativeVaultRecord, persistent: Boolean, sentAt: Long): Boolean {
        val sealed = order.sealIf(sentAt) { sealUnderLock(context, userId, record, persistent) }
        if (!sealed) Log.i(TAG, "arm not sealed (a forget arrived after it, or the write failed)")
        return sealed
    }

    private fun sealUnderLock(context: Context, userId: String, record: NativeVaultRecord, persistent: Boolean): Boolean {
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
            d.listFiles().orEmpty().filter { nativeCopyFileUserOf(it.name).let { owner -> owner != null && owner != userId } }.forEach {
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
            // The persistent-watch choice beside it: written AFTER the copy, so a marker never names a
            // copy that is not there.
            val marker = File(d, nativePersistentFileName(userId)!!)
            if (persistent) marker.createNewFile() else if (marker.exists() && !marker.delete()) {
                Log.e(TAG, "arm: the persistent-watch marker was NOT removed")
                return false
            }
            Log.i(TAG, "the mailbox password is sealed for the native watcher (persistent=$persistent)") // log-safe: one boolean choice, never the password
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
        val seen = order.writeSeen()
        val bytes = try {
            armed.file.readBytes()
        } catch (e: IOException) {
            Log.e(TAG, "the sealed copy was not read (${e.javaClass.simpleName}) - kept, retried at the next sign-in")
            return null
        }
        if (bytes.size <= IV_BYTES) return removeUnopenable(armed, seen, "truncated")
        return try {
            val key = existingKey() ?: return removeUnopenable(armed, seen, "no key")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, bytes, 0, IV_BYTES))
            cipher.updateAAD(nativeVaultAad(armed.userId))
            nativeVaultRecordOf(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES))
                ?: removeUnopenable(armed, seen, "unreadable record")
        } catch (_: AEADBadTagException) {
            removeUnopenable(armed, seen, "authentication failed")
        } catch (e: Exception) {
            Log.e(TAG, "the sealed copy did not open (${e.javaClass.simpleName}) - kept, retried at the next sign-in")
            null
        }
    }

    /** Removes a copy that can never open - unless a newer one was written since it was read. */
    private fun removeUnopenable(armed: Armed, seen: Long, why: String): NativeVaultRecord? {
        var gone = false
        val done = order.eraseIf(seen) { gone = armed.file.delete() }
        Log.e(TAG, "the sealed copy can never open ($why) - removed: $gone, newer copy kept: ${!done}") // log-safe: a fixed reason word and two booleans
        return null
    }

    /**
     * Erases [userId]'s copy (and its `.tmp` sibling, as Rust's `erase_vault`), or EVERY copy when
     * `null` (a remote revocation does not know the account) - and then the Keystore key too, so
     * nothing sealed under it can ever open again. [alsoCursor]: the account is gone (D8), its cursor
     * goes too. [seen]: the run's own erase, skipped when a copy was written after the one it opened
     * (`null`: a forget, which erases whatever is there). `false` when skipped. Idempotent.
     */
    fun erase(context: Context, userId: String?, alsoCursor: Boolean, seen: Long?): Boolean = order.eraseIf(seen) {
        val files = dir(context).listFiles().orEmpty().filter { f ->
            val owner = nativeCopyFileUserOf(f.name)
            owner != null && (userId == null || owner == userId)
        }
        for (f in files) {
            if (f.delete()) Log.i(TAG, "a sealed copy file is erased")
            else Log.e(TAG, "a sealed copy file was NOT erased")
        }
        if (alsoCursor && userId != null) {
            val c = cursorFile(context, userId)
            if (c.exists() && !c.delete()) Log.e(TAG, "the closed account's cursor was NOT erased")
        }
        if (userId == null) deleteKey()
        Log.i(TAG, "erase done: ${files.size} files, cursor too: $alsoCursor") // log-safe: a count and a boolean
    }.also { if (!it) Log.i(TAG, "erase skipped: a newer copy was written since it was opened") }

    /** Crypto-shred: the key goes, so a copy missed anywhere can never be opened. */
    private fun deleteKey() {
        try {
            val ks = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
            if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS)
            Log.i(TAG, "the sealed copy's Keystore key is deleted")
        } catch (e: Exception) {
            Log.e(TAG, "the Keystore key was NOT deleted: ${e.javaClass.simpleName}")
        }
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
