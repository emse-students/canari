package fr.emse.canari

import fr.emse.canari.call.CallOutput
import fr.emse.canari.call.CallServiceCommand
import fr.emse.canari.call.CallServiceEffect
import fr.emse.canari.call.OngoingCallSpec
import fr.emse.canari.call.OffScreenGate
import fr.emse.canari.call.SpecResult
import fr.emse.canari.call.StartRefusal
import fr.emse.canari.call.classifyStartRefusal
import fr.emse.canari.call.decide
import fr.emse.canari.call.holdsProximityScreenOff
import fr.emse.canari.call.pickCallOutput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The ongoing-call service's pure half (`fr.emse.canari.call`, WP-C-BG-A), compiled from the app tree.
 * What it cannot prove: that Android runs the service, keeps the network and the microphone - that
 * is the Mi 9T reading in calls.md.
 */
class OngoingCallTest {
    private val spec = OngoingCallSpec("Bob", "Appel audio", 1_000L, speaker = true)

    @Test
    fun `a start enters the foreground once, and a second start is the same call described again`() {
        assertEquals(CallServiceEffect.EnterForeground("A", spec), decide(null, CallServiceCommand.Start("A", spec)))
        assertEquals(CallServiceEffect.Refresh("A", spec), decide("A", CallServiceCommand.Start("A", spec)))
    }

    @Test
    fun `a start of another call while one runs takes the foreground over, naming the one whose stop was lost`() {
        assertEquals(CallServiceEffect.Replace("B", spec, previous = "A"), decide("A", CallServiceCommand.Start("B", spec)))
    }

    @Test
    fun `an update acts only on the running call - one in flight after the service left is expected`() {
        assertEquals(CallServiceEffect.Refresh("A", spec), decide("A", CallServiceCommand.Update("A", spec)))
        val afterLeft = decide(null, CallServiceCommand.Update("A", spec)) as CallServiceEffect.Ignore
        assertTrue(afterLeft.reason.contains("before the page heard"))
        val late = decide("B", CallServiceCommand.Update("A", spec)) as CallServiceEffect.Ignore
        assertTrue(late.reason.contains("earlier call"))
    }

    @Test
    fun `a stop leaves the running call or any call when it names none, and nothing else`() {
        assertEquals(CallServiceEffect.Leave("ended"), decide("A", CallServiceCommand.Stop("A", "ended")))
        assertEquals(CallServiceEffect.Leave("page gone"), decide("A", CallServiceCommand.Stop(null, "page gone")))
        assertTrue(decide("B", CallServiceCommand.Stop("A", "ended")) is CallServiceEffect.Ignore)
        assertTrue(decide(null, CallServiceCommand.Stop("A", "ended")) is CallServiceEffect.Ignore)
    }

    @Test
    fun `the hang-up names the running call, and with none there is nothing to act on`() {
        assertEquals(CallServiceEffect.ForwardHangUp("A"), decide("A", CallServiceCommand.HangUp))
        assertTrue(decide(null, CallServiceCommand.HangUp) is CallServiceEffect.Ignore)
    }

    @Test
    fun `a startForeground refused off screen is answered by the resume, any other refusal is final`() {
        assertEquals(StartRefusal.OFF_SCREEN, classifyStartRefusal(offScreenKind = true, appOnScreen = false))
        assertEquals(StartRefusal.REFUSED, classifyStartRefusal(offScreenKind = true, appOnScreen = true))
        assertEquals(StartRefusal.REFUSED, classifyStartRefusal(offScreenKind = false, appOnScreen = false))
        assertEquals("off-screen", StartRefusal.OFF_SCREEN.code)
        assertEquals("refused", StartRefusal.REFUSED.code)
    }

    @Test
    fun `the gate answers one refusal with one resume, and a start that goes ahead forgets an older one`() {
        val gate = OffScreenGate()
        val events = mutableListOf<String>()
        assertFalse(gate.admit("A", { false }) { events += "failed A" })
        gate.resumed { events += "foreground $it" }
        gate.resumed { events += "foreground $it" }
        assertEquals(listOf("failed A", "foreground A"), events)

        events.clear()
        gate.refusedOffScreen("B") { events += "failed B" }
        assertTrue(gate.admit("C", { true }) { events += "failed C" })
        gate.resumed { events += "foreground $it" }
        assertEquals(listOf("failed B"), events)
    }

    @Test
    fun `a resume racing a start ends in exactly one of - the start goes ahead, or its refusal then the answer`() {
        repeat(20_000) {
            val gate = OffScreenGate()
            val onScreen = AtomicBoolean(false)
            val events = Collections.synchronizedList(mutableListOf<String>())
            val go = CountDownLatch(1)
            var admitted = false
            val bridge = Thread {
                go.await()
                admitted = gate.admit("A", { onScreen.get() }) { events += "failed" }
            }
            val activity = Thread {
                go.await()
                onScreen.set(true) // MainActivity.onResume writes isInForeground first ...
                gate.resumed { events += "foreground" } // ... then asks the gate
            }
            bridge.start(); activity.start(); go.countDown(); bridge.join(); activity.join()
            if (admitted) assertEquals(emptyList<String>(), events.toList())
            else assertEquals(listOf("failed", "foreground"), events.toList())
        }
    }

    @Test
    fun `a description that crossed the bridge is validated and a refusal names the field`() {
        assertEquals(SpecResult.Valid(spec), OngoingCallSpec.of("Bob", "Appel audio", 1_000L, true, null, false))
        assertEquals(
            SpecResult.Valid(OngoingCallSpec("Bob", "Connexion...", null, false, "user-b", true)),
            OngoingCallSpec.of("Bob", "Connexion...", null, false, "user-b", true),
        )
        assertEquals(SpecResult.Refused("title is empty"), OngoingCallSpec.of(" ", "x", null, true, null, false))
        assertEquals(SpecResult.Refused("text is missing"), OngoingCallSpec.of("Bob", null, null, true, null, false))
        assertEquals(
            SpecResult.Refused("connectedAtMs=0 is not an instant"),
            OngoingCallSpec.of("Bob", "x", 0L, true, null, false),
        )
        assertEquals(SpecResult.Refused("speaker is missing"), OngoingCallSpec.of("Bob", "x", null, null, null, false))
        assertEquals(SpecResult.Refused("muted is missing"), OngoingCallSpec.of("Bob", "x", null, true, null, null))
    }

    @Test
    fun `a blank peer id names nobody, so no photo is fetched for it`() {
        val valid = OngoingCallSpec.of("Bob", "x", null, false, "  ", false) as SpecResult.Valid
        assertNull(valid.spec.peerUserId)
    }

    @Test
    fun `the notification's mute goes to the running call, and with none there is nothing to act on`() {
        assertEquals(CallServiceEffect.ForwardMute("A"), decide("A", CallServiceCommand.ToggleMute))
        assertTrue(decide(null, CallServiceCommand.ToggleMute) is CallServiceEffect.Ignore)
    }

    @Test
    fun `the screen goes dark against the cheek on the earpiece only`() {
        assertTrue(holdsProximityScreenOff(CallOutput.EARPIECE))
        for (output in CallOutput.values().filter { it != CallOutput.EARPIECE }) {
            assertFalse("$output", holdsProximityScreenOff(output))
        }
        assertFalse(holdsProximityScreenOff(null))
    }

    @Test
    fun `the speaker is the loudspeaker, whatever else is plugged in`() {
        val all = CallOutput.values().toList()
        assertEquals(CallOutput.SPEAKER, pickCallOutput(all, speaker = true))
        assertNull(pickCallOutput(listOf(CallOutput.EARPIECE), speaker = true))
    }

    @Test
    fun `off the speaker, the most personal output present wins`() {
        val phone = listOf(CallOutput.SPEAKER, CallOutput.EARPIECE)
        assertEquals(CallOutput.EARPIECE, pickCallOutput(phone, speaker = false))
        assertEquals(CallOutput.WIRED_HEADSET, pickCallOutput(phone + CallOutput.WIRED_HEADSET, speaker = false))
        assertEquals(
            CallOutput.BLUETOOTH_SCO,
            pickCallOutput(phone + CallOutput.WIRED_HEADSET + CallOutput.BLUETOOTH_SCO, speaker = false),
        )
        assertEquals(
            CallOutput.BLE_HEADSET,
            pickCallOutput(phone + CallOutput.BLUETOOTH_SCO + CallOutput.BLE_HEADSET, speaker = false),
        )
        assertEquals(CallOutput.HEARING_AID, pickCallOutput(CallOutput.values().toList(), speaker = false))
        assertNull(pickCallOutput(listOf(CallOutput.SPEAKER, CallOutput.OTHER), speaker = false))
    }
}
