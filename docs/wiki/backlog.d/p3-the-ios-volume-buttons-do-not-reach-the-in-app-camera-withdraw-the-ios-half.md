## P3 - the iOS volume buttons do not reach the in-app camera: withdraw the iOS half of the volume shutter

target: 1.8.0

**Read 2026-11-15 on the iPhone 12** (TestFlight `1.6.12-alpha.2`, iOS 27, dev). With the camera open from the composer the log shows `[CanariCamera] AVCaptureEventInteraction installed on the WebView` and `[CanariCamera] armed by the page`. Three volume presses (down, down, up) were then delivered through the device's own button path (SpringBoard logged `VolumeDecrease` and `SBVolumeControl -- volume decrement`): the system volume moved by one step each time, the volume button client being WebKit's capture session, and **no `volume button down` / `up` line came from Canari**. That is the open question of [the camera entry](camera-keeps-its-layout-and-volume-shutter.md) answered in its own terms: WebKit's `getUserMedia` capture does not count for `AVCaptureEventInteraction`, so the iOS half does nothing a member can use and also changes the volume while the camera is up.

**To do:** withdraw the iOS half as the entry said it would be, not patch it: remove the `AVCaptureEventInteraction` install and the `CanariCamera` arm/disarm bridge from `canari_ios.mm`, keep Android's, and let the docs say that iOS has no volume shutter. Remove the iOS volume lines from the readings owed.
