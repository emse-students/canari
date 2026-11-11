package fr.emse.canari

import fr.emse.canari.camera.CameraKeyAction
import fr.emse.canari.camera.Keys
import fr.emse.canari.camera.ORIENTATION_UNKNOWN
import fr.emse.canari.camera.angleWorthSending
import fr.emse.canari.camera.cameraKeyAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The camera's volume shutter and the angle filter (screen-orientation.md, "The camera keeps its layout"). */
class CameraHardwareTest {
    private val up = Keys.KEYCODE_VOLUME_UP
    private val down = Keys.KEYCODE_VOLUME_DOWN

    @Test
    fun aVolumeKeyIsTheSystemsWhileTheCameraIsNotArmed() {
        for (key in listOf(up, down)) {
            assertEquals(CameraKeyAction.PASS, cameraKeyAction(false, key, Keys.ACTION_DOWN, 0))
            assertEquals(CameraKeyAction.PASS, cameraKeyAction(false, key, Keys.ACTION_UP, 0))
        }
    }

    @Test
    fun armedEitherVolumeKeyIsAPressThenARelease() {
        for (key in listOf(up, down)) {
            assertEquals(CameraKeyAction.PRESS, cameraKeyAction(true, key, Keys.ACTION_DOWN, 0))
            assertEquals(CameraKeyAction.RELEASE, cameraKeyAction(true, key, Keys.ACTION_UP, 0))
        }
    }

    @Test
    fun aHeldKeysRepeatsAreSwallowedNeverSentAndNeverTheSystems() {
        assertEquals(CameraKeyAction.SWALLOW, cameraKeyAction(true, down, Keys.ACTION_DOWN, 1))
        assertEquals(CameraKeyAction.SWALLOW, cameraKeyAction(true, down, Keys.ACTION_DOWN, 30))
    }

    @Test
    fun everyOtherKeyPassesEvenArmed() {
        val back = 4
        assertEquals(CameraKeyAction.PASS, cameraKeyAction(true, back, Keys.ACTION_DOWN, 0))
        assertEquals(CameraKeyAction.PASS, cameraKeyAction(true, back, Keys.ACTION_UP, 0))
    }

    @Test
    fun theFirstAngleAlwaysGoesAndAFlatPhoneSendsNothing() {
        assertTrue(angleWorthSending(null, 0))
        assertFalse(angleWorthSending(null, ORIENTATION_UNKNOWN))
        assertFalse(angleWorthSending(90, ORIENTATION_UNKNOWN))
    }

    @Test
    fun onlyAMoveOfTenDegreesIsSentAcrossZeroToo() {
        assertFalse(angleWorthSending(90, 95))
        assertTrue(angleWorthSending(90, 100))
        assertFalse(angleWorthSending(355, 3))
        assertTrue(angleWorthSending(355, 5))
        assertTrue(angleWorthSending(5, 355))
    }
}
