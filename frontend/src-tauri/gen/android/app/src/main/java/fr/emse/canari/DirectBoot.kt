package fr.emse.canari

import android.content.Context
import android.os.UserManager

/**
 * Whether this process can read the app's credential-encrypted storage yet.
 *
 * Android creates our process before the user's first unlock after a reboot, and it is NOT our
 * doing: `tauri-plugin-notification` merges `app.tauri.notification.LocalNotificationRestoreReceiver`
 * into the manifest with `android:directBootAware="true"` and an intent filter on
 * `LOCKED_BOOT_COMPLETED`. One direct-boot-aware component is enough to start the process, and
 * `CanariApplication.onCreate` then runs against locked storage - which is how a process that
 * serves push for the rest of its life can be built on reads that could not succeed.
 *
 * The distinction this exists to make is between **absent** and **not readable yet**. While locked:
 *
 * - a file in `context.dataDir` reports `exists() == false` and reads fail with
 *   `errno 126 (Required key not available)`, so every `if (!file.exists()) return` reads as
 *   "nothing to do" when it means "cannot tell";
 * - a `SharedPreferences` opened now loads EMPTY and is cached for the life of the process, so it
 *   stays empty after the unlock - which is why the answer is to avoid opening it at all rather
 *   than to re-read it later;
 * - an AndroidKeyStore alias may be present and unreadable, which is not the same as missing.
 *
 * Callers must therefore ask this BEFORE touching any of the three, and treat `false` as "come
 * back later", never as "the data is gone".
 */
internal object DirectBoot {

    /**
     * True once credential-encrypted storage is readable - i.e. from the user's first unlock after
     * boot onwards, for the rest of the boot. It does NOT go false again when the screen re-locks.
     */
    fun storageReadable(context: Context): Boolean {
        val um = context.getSystemService(UserManager::class.java) ?: return true
        return um.isUserUnlocked
    }
}
