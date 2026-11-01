## P3 - A late native-library pick after "Rouvrir la camera" still reaches the review (#2655 review, 2026-10-28)

On the native library path (`ReelCapture.openGallery`, the iOS app), tapping "Rouvrir la camera"
while `pickNatively` is still pending runs `endPicking` early; the promise's later `.finally` is then
a no-op, but a file it hands over still goes through `takePickedVideo` and replaces the live camera
with a review. Arguably right (the member did pick it), and untested either way: owed a test that
settles the native promise after the reopen, and a decision on whether a pick that arrives after the
member chose the camera is kept or dropped.
