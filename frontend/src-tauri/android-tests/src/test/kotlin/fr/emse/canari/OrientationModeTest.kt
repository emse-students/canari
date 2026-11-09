package fr.emse.canari

import fr.emse.canari.orientation.OrientationMode
import fr.emse.canari.orientation.ScreenOrientation
import fr.emse.canari.orientation.requestedOrientationFor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The page's orientation modes and the `requestedOrientation` each one becomes (screen-orientation.md). */
class OrientationModeTest {
    @Test
    fun parsesTheThreeWireValuesAndNothingElse() {
        assertEquals(OrientationMode.PORTRAIT, OrientationMode.parse("portrait"))
        assertEquals(OrientationMode.AUTO, OrientationMode.parse("auto"))
        assertEquals(OrientationMode.LANDSCAPE, OrientationMode.parse("landscape"))
        assertNull(OrientationMode.parse("Landscape"))
        assertNull(OrientationMode.parse(""))
        assertNull(OrientationMode.parse(null))
    }

    @Test
    fun aPhoneIsPortraitUntilAScreenAsksAndAutoRespectsTheRotationLock() {
        assertEquals(ScreenOrientation.PORTRAIT, requestedOrientationFor(OrientationMode.PORTRAIT, true))
        // USER, never SENSOR: SENSOR would turn the screen with the rotation lock on.
        assertEquals(ScreenOrientation.USER, requestedOrientationFor(OrientationMode.AUTO, true))
        assertEquals(ScreenOrientation.USER_LANDSCAPE, requestedOrientationFor(OrientationMode.LANDSCAPE, true))
    }

    @Test
    fun aTabletRotatesFreelyAndOnlyTheButtonForcesLandscape() {
        assertEquals(ScreenOrientation.UNSPECIFIED, requestedOrientationFor(OrientationMode.PORTRAIT, false))
        assertEquals(ScreenOrientation.UNSPECIFIED, requestedOrientationFor(OrientationMode.AUTO, false))
        assertEquals(ScreenOrientation.USER_LANDSCAPE, requestedOrientationFor(OrientationMode.LANDSCAPE, false))
    }
}
