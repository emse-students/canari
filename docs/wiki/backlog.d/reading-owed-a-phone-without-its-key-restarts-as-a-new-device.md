## Reading owed - a phone whose data arrived without its key restarts as a new device (owner, 2026-11-20)

target: 1.7.2

Built: on a PIN the server accepted over a hardware-held key proven gone (`absent`, `mismatch`), the
phone discards its local state through the forgot-PIN reset's LOCAL half (never `pin-reset`), shows one
toast, unlocks again with the same PIN and enrols as a new device; `local_state_unopenable` shows
"Repartir de zero sur cet appareil" directly ([auth](../frontend/modules/auth.md#the-pin-gate-says-one-short-thing-and-shows-the-control-that-does-it-2026-11-20)).

The reading that closes it, on a bench phone with a second device of the same account online: delete
the keystore entry (or restore the app's data onto the other bench phone), type the right PIN, and see
(1) no error and no button, one toast; (2) the logcat or syslog line `[DEVICE_RESTART]` at ERROR with
the refusal; (3) the phone signed in as a NEW device (a new device id, the other device still listed
and still signed in, the PIN unchanged on it); (4) the history coming back from the other device.
