package fr.emse.canari

import app.tauri.gallery.ShareTargetsUpgrade
import app.tauri.gallery.UpgradeGeneration
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE SHARE-SHEET SHORTCUTS' LATE PICTURE (reading `1.7.3-alpha.6`, steps 2, 4 and 5 of the share
 * shortcuts entry): none of them can be read on a bench - no test account has a profile photo, and
 * signing the shared seat out would drop its state under the other sittings - so the native half is
 * pinned here, on the part of `ShareTargets` that needs nothing from Android
 * ([ShareTargetsUpgrade], compiled from the plugin's own source).
 */
class ShareTargetsUpgradeTest {

    /** One published target as the upgrade sees it: its shortcut id and rank. */
    private data class Pending(val id: String, val rank: Int)

    /** The platform's dynamic set, as the pushes leave it: id to the picture it carries. */
    private class Platform {
        val pushed = mutableListOf<Pair<String, String>>()
        val set = linkedMapOf<String, String>()
        fun push(id: String, picture: String): Boolean {
            pushed.add(id to picture)
            set[id] = picture
            return true
        }
    }

    private fun upgrade(
        pending: List<Pending>,
        started: Long,
        generations: UpgradeGeneration,
        platform: Platform,
        fetched: (Pending) -> String?,
    ) = ShareTargetsUpgrade.run(
        pending, started, generations,
        fetch = fetched,
        push = { p, picture -> platform.push(p.id, picture) },
        onRefused = { error("the platform refused ${it.id}") },
        onFailed = { p, e -> error("${p.id} failed: $e") },
    )

    @Test
    fun `the fetched picture upgrades the SAME shortcut id and the pass says 1 of 1`() {
        // Three shortcuts published, one whose picture is not in the cache: only it is pending.
        val generations = UpgradeGeneration()
        val started = generations.next()
        val platform = Platform().apply {
            set["c:a"] = "initials"; set["c:b"] = "initials"; set["c:c"] = "initials"
        }

        val outcome = upgrade(listOf(Pending("c:b", 1)), started, generations, platform) { "bitmap-of-${it.id}" }

        assertEquals(listOf("c:b" to "bitmap-of-c:b"), platform.pushed)
        assertEquals("the same ids, no new one", listOf("c:a", "c:b", "c:c"), platform.set.keys.toList())
        assertEquals("initials", platform.set["c:a"])
        assertEquals("bitmap-of-c:b", platform.set["c:b"])
        assertFalse(outcome.superseded)
        assertEquals(1, outcome.done)
        assertEquals(1, outcome.total)
    }

    @Test
    fun `a picture the server has none of keeps its initials and counts as not set`() {
        val generations = UpgradeGeneration()
        val platform = Platform()
        val outcome = upgrade(listOf(Pending("c:a", 0), Pending("c:b", 1)), generations.next(), generations, platform) {
            if (it.id == "c:a") null else "bitmap"
        }
        assertEquals(listOf("c:b" to "bitmap"), platform.pushed)
        assertEquals(1, outcome.done)
        assertEquals(2, outcome.total)
    }

    @Test
    fun `clear then a late upgrade result leaves the list empty and re-publishes no id`() {
        val generations = UpgradeGeneration()
        val started = generations.next()
        val platform = Platform().apply { set["c:a"] = "initials" }

        // The sign-out clear: the set is emptied and the generation ended BEFORE the fetch answers.
        generations.invalidate()
        platform.set.clear()
        var fetchedBeforeClear = 0
        val outcome = upgrade(listOf(Pending("c:a", 0), Pending("c:b", 1)), started, generations, platform) {
            fetchedBeforeClear++
            "late-bitmap"
        }

        assertTrue(outcome.superseded)
        assertTrue("nothing was pushed back", platform.pushed.isEmpty())
        assertTrue("the list stays empty", platform.set.isEmpty())
        // The first fetch answered and was dropped at the guard; the rest of the pass was not run.
        assertEquals(1, fetchedBeforeClear)
    }

    @Test
    fun `a clear that lands between two pictures stops the pass after the first`() {
        val generations = UpgradeGeneration()
        val started = generations.next()
        val platform = Platform()
        val outcome = upgrade(listOf(Pending("c:a", 0), Pending("c:b", 1)), started, generations, platform) {
            // The clear arrives while the SECOND picture is being fetched.
            if (it.id == "c:b") generations.invalidate()
            "bitmap-of-${it.id}"
        }
        assertEquals(listOf("c:a" to "bitmap-of-c:a"), platform.pushed)
        assertTrue(outcome.superseded)
    }

    @Test
    fun `the two log lines a reader looks for are the ones ShareTargets writes`() {
        val source = File(System.getProperty("user.dir"), "../plugins/tauri-plugin-gallery/android/src/main/java/ShareTargets.kt").readText()
        assertTrue(source.contains("publish: \${toFetch.size} picture(s) to fetch after the publish"))
        assertTrue(source.contains("upgradeIcons: \$done of \${pending.size} picture(s) set"))
        assertTrue(source.contains("ShareTargetsUpgrade.run("))
    }

    @Test
    fun `the menu shortcut and the notification shortcut take their picture from ONE adaptive helper`() {
        // A Bitmap cannot be built on the JVM, so "equal icon bytes" is pinned where it is decided:
        // both shortcut builders hand their circle to `ShortcutIcons.adaptive`, and neither builds an
        // icon of its own - a second path is how the two pictures would drift.
        val root = File(System.getProperty("user.dir"), "..")
        val menu = File(root, "plugins/tauri-plugin-gallery/android/src/main/java/ShareTargets.kt").readText()
        val notification = File(root, "gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt").readText()
        assertEquals(1, Regex("""ShortcutIcons\.adaptive\(""").findAll(menu).count())
        assertTrue(Regex("""\.setIcon\(ShortcutIcons\.adaptive\(icon\)\)""").containsMatchIn(notification))
        assertFalse("the menu builds no icon of its own", menu.contains("IconCompat.create"))
        // Both draw the disc from the same source: the initials fallback is `Source.initials`.
        assertTrue(menu.contains("icons?.initials(context, target.label)"))
    }
}
