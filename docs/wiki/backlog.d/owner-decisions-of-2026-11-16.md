## The owner's decisions of 2026-11-15 and 2026-11-16

target: 1.7.0

Recorded so no question answered here is asked again. Each line names where its detail lives.

### Test accounts and the bench

- **A test account NEVER signs in through CAS.** It uses MiConnect's local password login ("Connexion
  par mot de passe"); its credentials live only in the rig's `test-accounts.json`, outside the work tree
  ([harness README](../../../tools/cross-client-harness/README.md)).
- **The phone lenses were uncovered; the front camera is an acceptable fallback for camera readings**
  on the bench phones ([device-verification](../device-verification.md)).
- **shellcheck 0.10.0 is installed by the lead on the workstation** (the lead's own machine, not the
  shared host).

### Order of work

- **Everything open stays in `1.7.0`**: no entry is triaged to `1.8.0` ([plan](../plan.md)).
- **The `1.7.0` stable waits until every reading owed is taken**
  ([readings owed](../plan.md#readings-owed)).

### Earlier decisions, recorded here with them

- **The PIN gate's sign-out moved to a top row**, away from the tab bar it overlapped.
- **The push was lightened.**
- **The "Entre etudiants uniquement" toggle sits under "Plus d'options".**
