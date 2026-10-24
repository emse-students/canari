package fr.emse.canari

import fr.emse.canari.push.OwedTokenDeletion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The order of the token deletion a sign-out owes ([OwedTokenDeletion]), compiled from the app
 * tree. What these pin: concurrent callers delete the token and fetch a fresh one ONCE between
 * them, the fresh token is fetched only after the mark is gone, and a failed deletion keeps the
 * mark and fetches nothing.
 */
class OwedTokenDeletionTest {

    /** A fake device: the mark, and every step in the order it ran, across threads. */
    private class Device(owed: Boolean, private val deleteSucceeds: Boolean = true) : OwedTokenDeletion.Ops {
        @Volatile var markOnDisk = owed
        val steps: MutableList<String> = Collections.synchronizedList(mutableListOf())
        /** Released by the test once every caller has started, so their runs overlap. */
        val gate = CountDownLatch(1)

        override fun isOwed(): Boolean = markOnDisk

        override fun deleteToken(): Boolean {
            gate.await(5, TimeUnit.SECONDS)
            steps += "delete"
            return deleteSucceeds
        }

        override fun forgetTokenMirror() {
            steps += "forget"
        }

        override fun removeOwedMark(): Boolean {
            markOnDisk = false
            steps += "unmark"
            return true
        }

        override fun fetchAndMirrorFreshToken() {
            steps += "fetch"
        }
    }

    @Test
    fun concurrent_callers_delete_and_fetch_once_in_order() {
        val device = Device(owed = true)
        val callers = 4
        val pool = Executors.newFixedThreadPool(callers)
        val started = CountDownLatch(callers)
        val answers = (1..callers).map {
            pool.submit<Boolean> {
                started.countDown()
                OwedTokenDeletion.complete(device)
            }
        }
        assertTrue(started.await(5, TimeUnit.SECONDS))
        device.gate.countDown()
        val results = answers.map { it.get(5, TimeUnit.SECONDS) }
        pool.shutdown()

        assertTrue("every caller learns nothing is owed any more", results.all { it })
        assertEquals(listOf("delete", "forget", "unmark", "fetch"), device.steps.toList())
        assertFalse(device.markOnDisk)
    }

    @Test
    fun a_failed_deletion_keeps_the_mark_and_fetches_nothing() {
        val device = Device(owed = true, deleteSucceeds = false).also { it.gate.countDown() }
        assertFalse(OwedTokenDeletion.complete(device))
        assertTrue(device.markOnDisk)
        assertEquals(listOf("delete"), device.steps.toList())
    }

    @Test
    fun nothing_runs_when_no_deletion_is_owed() {
        val device = Device(owed = false).also { it.gate.countDown() }
        assertTrue(OwedTokenDeletion.complete(device))
        assertTrue(device.steps.isEmpty())
    }
}
