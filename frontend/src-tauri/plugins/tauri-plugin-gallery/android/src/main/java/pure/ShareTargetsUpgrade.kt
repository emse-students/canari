package app.tauri.gallery

/**
 * The late picture upgrade of the share-sheet shortcuts, without the platform calls - pure, so a JVM
 * test pins it (`ShareTargetsUpgradeTest`; no Android import allowed in this directory).
 *
 * A publish draws a target with its initials when its picture is not cached, then fetches the
 * pictures afterwards and pushes each target again under the SAME id. That second step is this
 * function: [fetch] gets the picture of one pending item (null: none, the initials stay), [push]
 * sets it on the platform, and every push goes through [UpgradeGeneration.runIfCurrent], so a clear
 * or a later publish ends the loop and nothing is pushed back after it.
 */
object ShareTargetsUpgrade {

    /** What one upgrade pass did: [done] pushes of [total] pending items, or [superseded] midway. */
    class Outcome(val done: Int, val total: Int, val superseded: Boolean)

    /**
     * Fetches and pushes each of [pending] under [started]. A fetch that throws, or a refused push,
     * is reported through [onFailed] / [onRefused] and the pass goes on with the next item.
     */
    fun <T, P : Any> run(
        pending: List<T>,
        started: Long,
        generations: UpgradeGeneration,
        fetch: (T) -> P?,
        push: (T, P) -> Boolean,
        onRefused: (T) -> Unit,
        onFailed: (T, Exception) -> Unit,
    ): Outcome {
        var done = 0
        for (item in pending) {
            try {
                val picture = fetch(item) ?: continue
                val current = generations.runIfCurrent(started) {
                    if (push(item, picture)) done++ else onRefused(item)
                    true
                }
                if (current == null) return Outcome(done, pending.size, superseded = true)
            } catch (e: Exception) {
                onFailed(item, e)
            }
        }
        return Outcome(done, pending.size, superseded = false)
    }
}
