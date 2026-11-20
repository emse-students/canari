package app.tauri.gallery

/**
 * Which published set a late icon upgrade belongs to - pure, so a JVM test can pin it
 * (`UpgradeGenerationTest`; no Android import allowed in this directory).
 *
 * A publish starts a new generation ([next]) and a clear (sign-out) ends the current one
 * ([invalidate]). An upgrade fetched under an older generation must not push its shortcut back, and
 * [runIfCurrent] is the only way to push: the check and the push are ONE step under the lock, so a
 * clear cannot slip between them.
 */
class UpgradeGeneration {
    private var current = 0L

    /** Starts a new generation and returns it; every upgrade of an older one is now stale. */
    @Synchronized
    fun next(): Long = ++current

    /** Makes every upgrade started so far stale, with no new generation to run. */
    @Synchronized
    fun invalidate() {
        current++
    }

    /** Runs [block] only when [started] is still the current generation; null when it is stale. */
    @Synchronized
    fun <T> runIfCurrent(started: Long, block: () -> T): T? = if (started == current) block() else null
}
