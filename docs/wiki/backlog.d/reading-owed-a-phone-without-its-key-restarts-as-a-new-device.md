## Reading owed - a phone whose data arrived without its key restarts as a new device (owner, 2026-11-20)

target: 1.7.3

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

Built: on a PIN the server accepted over a hardware-held key proven gone (`absent`, `mismatch`), the
phone discards its local state through the forgot-PIN reset's LOCAL half (never `pin-reset`), shows one
toast, unlocks again with the same PIN and enrols as a new device; `local_state_unopenable` shows
"Repartir de zero sur cet appareil" directly ([auth](../frontend/modules/auth.md#the-pin-gate-says-one-short-thing-and-shows-the-control-that-does-it-2026-11-20)).

The reading that closes it, on a bench phone with a second device of the same account online: delete
the keystore entry (or restore the app's data onto the other bench phone), type the right PIN, and see
(1) no error and no button, one toast; (2) the logcat or syslog line `[DEVICE_RESTART]` at ERROR with
the refusal; (3) the phone signed in as a NEW device (a new device id, the other device still listed
and still signed in, the PIN unchanged on it); (4) the history coming back from the other device.
On Android, also (5) a data restore onto the other bench phone (SharedPreferences travel, the Keystore
alias does not) answers `absent`, never `unreadable`.

**A clone pays one rotation.** The re-enrolment retires the old device id on the server
(`reenrolLostState`). When the data came by Quick Start or a restore while the OLD phone is still in
use under the same id, that phone meets its id retired and rotates its own identity: read it too.

**2026-11-20, S16 (`1.7.2-alpha.1`, [readings](../device-verification.md#the-readings-of-2026-11-20-s16-172-alpha1-the-birthday-ring-the-composer-gap-the-pin-gate-the-ios-backup-pass-the-rediffusion-switch-the-web-image-drop-miconnect)): NOT TAKEN on either phone, the wrong-PIN text READ.** No documented safe way to lose the key exists for this bench: the release APK is not debuggable, so adb reaches neither its SharedPreferences nor its Keystore alias, the only other Android phone is the owner's personal one, and the iPhone's Keychain item cannot be removed from outside the app. What would make it readable: a bench build (debuggable, or a dev-only control) that deletes the Keystore alias alone, so `absent` is produced on the Mi 9T. **Read on the way:** the wrong-PIN text on the web seat W2 (`PIN incorrect. Réessayez, ou touchez "PIN oublié ?".`, with "Se déconnecter" and "PIN oublié ?" as its only controls, no old-PIN link) and on the iPhone 12 in English (`Wrong PIN. Try again, or tap "Forgot your PIN?".`).
