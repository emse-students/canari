## P3 - on Android the live sheet says "another app is using the camera" when the camera permission is OFF

target: 1.8.0

**What was seen (Mi 9T, `1.7.0-alpha.2`, 2026-11-16, [readings](../device-verification.md#the-mi-9t-readings-of-2026-11-16-the-owed-rows-170-alpha2)):** with the app's `CAMERA` permission not granted
(`dumpsys package`: `android.permission.CAMERA: granted=false`; `dumpsys media.camera`: `REJECT ... cannot open camera "1" without camera permission`),
the "Passer en direct" sheet drew a black preview, the line "Une autre application l'utilise. Fermez-la, puis reessayez." with a "Reessayer" button, and a greyed
"Demarrer le live". Nothing named the permission, and "Reessayer" cannot succeed until it is granted in the system settings. After `pm grant ... CAMERA` and
an app restart the same sheet enabled Start.

**Why it matters:** the sentence sends the member to close apps that are not the cause, and the greyed Start is easy to mistake for another refusal (here it sat beside a
suspension line, so a suspension reading could have passed for the wrong reason). **Owed:** a denied permission is its own state with its own sentence and a route to the settings;
the camera tab and the composer's camera should be read for the same wording.
