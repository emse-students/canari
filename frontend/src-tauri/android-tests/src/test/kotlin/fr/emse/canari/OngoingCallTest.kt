package fr.emse.canari

import fr.emse.canari.call.CallOutput
import fr.emse.canari.call.CallServiceCommand
import fr.emse.canari.call.CallServiceEffect
import fr.emse.canari.call.OngoingCallSpec
import fr.emse.canari.call.SpecResult
import fr.emse.canari.call.decide
import fr.emse.canari.call.pickCallOutput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ongoing-call service's pure half (`fr.emse.canari.call`, WP-C-BG-A), compiled from the app tree.
 * What it cannot prove: that Android runs the service, keeps the network and the microphone - that
 * is the Mi 9T reading in calls.md.
 */
class OngoingCallTest {
    private val spec = OngoingCallSpec("Bob", "Appel audio", 1_000L, speaker = true)

    @Test
    fun `a start enters the foreground once, and a second start is the same call described again`() {
        assertEquals(CallServiceEffect.EnterForeground(spec), decide(false, CallServiceCommand.Start(spec)))
        assertEquals(CallServiceEffect.Refresh(spec), decide(true, CallServiceCommand.Start(spec)))
    }

    @Test
    fun `an update before any start is refused - the web and the service disagree`() {
        val effect = decide(false, CallServiceCommand.Update(spec))
        assertTrue(effect is CallServiceEffect.Ignore)
        assertEquals(CallServiceEffect.Refresh(spec), decide(true, CallServiceCommand.Update(spec)))
    }

    @Test
    fun `a stop leaves only a running call, and says why otherwise`() {
        assertEquals(CallServiceEffect.Leave("ended"), decide(true, CallServiceCommand.Stop("ended")))
        assertTrue(decide(false, CallServiceCommand.Stop("ended")) is CallServiceEffect.Ignore)
    }

    @Test
    fun `the hang-up is forwarded to the page, which owns the call, and never ends it here`() {
        assertEquals(CallServiceEffect.ForwardHangUp, decide(true, CallServiceCommand.HangUp))
        assertTrue(decide(false, CallServiceCommand.HangUp) is CallServiceEffect.Ignore)
    }

    @Test
    fun `a description that crossed the bridge is validated and a refusal names the field`() {
        assertEquals(SpecResult.Valid(spec), OngoingCallSpec.of("Bob", "Appel audio", 1_000L, true))
        assertEquals(
            SpecResult.Valid(OngoingCallSpec("Bob", "Connexion...", null, false)),
            OngoingCallSpec.of("Bob", "Connexion...", null, false),
        )
        assertEquals(SpecResult.Refused("title is empty"), OngoingCallSpec.of(" ", "x", null, true))
        assertEquals(SpecResult.Refused("text is missing"), OngoingCallSpec.of("Bob", null, null, true))
        assertEquals(
            SpecResult.Refused("connectedAtMs=0 is not an instant"),
            OngoingCallSpec.of("Bob", "x", 0L, true),
        )
        assertEquals(SpecResult.Refused("speaker is missing"), OngoingCallSpec.of("Bob", "x", null, null))
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
