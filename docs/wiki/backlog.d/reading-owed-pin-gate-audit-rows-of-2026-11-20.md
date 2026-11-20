## Reading owed - the PIN gate's audit rows of 2026-11-20 (deadline, 429, confirmation, removed device)

target: 1.7.2

Built ([auth](../frontend/modules/auth.md#pin-and-device-key)): every PIN request lives under the app's
request deadline and ends as "unreachable"; a 429 reads "Trop d'essais. Reessayez a HH:MM."; a first
setup asks "Confirmez votre PIN"; an unanswered `pin-status` shows the gate with no keypad and
"Reessayer"; a removed device shows "Cet appareil a ete retire de votre compte" with no keypad.

The reading that closes it, on a bench phone and in a browser on dev: (1) a new test account's first
unlock asks the PIN twice, a differing second entry is refused and asked again; (2) with the link
cut after the keypad is drawn (airplane mode on the phone, offline in DevTools), "Deverrouiller" ends in
the unreachable text within the deadline, and works again once back; (3) a device removed from another
device, then typing the PIN at its gate, shows the removed state and "Se deconnecter" leads to the
sign-in page; (4) the sign-in page shows "Se connecter avec un mot de passe".
