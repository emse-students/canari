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

### Readings and chantiers decided on the same days

- **The "first message notifies" reading may delete, through the product on dev, an existing
  conversation between two bench accounts**, to stage a first message from an account that has none.
- **The iPhone half of the PIN gate sign-out is read by re-enrolling the iPhone**: `gamma` may lose its
  local history there. (Written that afternoon as "the app is never uninstalled"; withdrawn by decision
  (13) below - an uninstall on a bench phone is allowed.)
- **The "Organisations" feed Back stays owed**, repeated with a history logger until three clean runs on
  `alpha.5` or the failure is caught.
- **Campus trends: the threshold becomes a server-side setting**, the production value unchanged and
  lowered on dev only.
- **Forms: an organiser chooses, per form, which respondent account fields are joined to each answer**
  (Nom, Prénom, E-mail, Promo et formation, Statut élève/personnel, Campus), each optional, building on
  the existing "Demander aux invités" block. The respondent sees what is transmitted; the answers list
  and the XLSX export carry the columns and a filter; a field that cannot come from an account (a
  guest, an anonymous form) is asked instead.

### The afternoon of 2026-11-16

- **(12) A private salon's unread badge counts only the messages posted AFTER access was granted**
  (principle 3 of [the charter](../../principes.md), *your attention is not for sale*); the history
  stays readable. Every grant raises the grantee's private `clearedMarks[salon]` to the grant instant,
  no migration, "Lu par" untouched ([chat](../frontend/modules/chat.md#a-salons-badge-starts-at-the-grant-owner-2026-11-16),
  [the reading owed](p3-a-private-salon-granted-late-badges-its-whole-past.md)).
- **(13) The bench phones are a sandbox: uninstalling the app on the Mi 9T or the iPhone 12 is
  allowed.** The old "never uninstall" rule is withdrawn; `install -r` stays the default because it
  keeps the enrolment, and an uninstall is chosen knowing it costs the device
  ([harness README](../../../tools/cross-client-harness/README.md)).
- **(14) "Rester connecté sur cet appareil" on the PIN gate is TICKED by default**, and a recorded
  choice, an unticked one included, is shown as recorded
  ([sessions](../sessions.md#stay-signed-in-on-the-pin-gate-ticked-by-default-in-the-app-unticked-on-the-web-owner-2026-11-16)).
- **(15) Everything stays in `1.7.0`, the large features included** - group calls, "Envoyer a..." to
  several targets and CanaReels in chats, screen share in lives on desktop: the stable waits for them
  ([plan](../plan.md)).
- **(24) (evening, refining (14)) "Rester connecté sur cet appareil" stays TICKED by default in the iOS
  and Android apps and is UNTICKED by default on the web**, answering the review note that on a shared
  computer the PIN is the last barrier a forgotten sign-out leaves (principle 1). The platform is the
  existing `isTauriRuntime()`, so the desktop app counts as an app
  ([sessions](../sessions.md#stay-signed-in-on-the-pin-gate-ticked-by-default-in-the-app-unticked-on-the-web-owner-2026-11-16)).
- **(16) Reading halves that need hardware the bench lacks are DELETED, not moved** (Android 9-12, a
  second Android 13+ maker, an iPad in Split View or Stage Manager): the Mi 9T and the iPhone 12 are
  enough.
- **(17) The two readings that need a real outage** (a deploy's 502/503/504 read as "not now"; one
  "server already unreachable" line per spell) are taken during the `1.7.0-alpha.6` deploy of dev,
  otherwise by stopping a dev service on purpose (dev only).
- **(18) `1.7.0-alpha.6` is cut once #3687 and #3691 are merged.**
- **(19) The desktop screen-share-in-lives reading is taken by the bench first** (Chrome launched with
  automatic screen selection); only what truly needs a hand is left to the owner.
- **(20) Every reading half the bench cannot stage is DELETED** (a bench build, real APNs, a real
  production event, a timed coincidence, hardware outside the bench): *"Supprime les lectures
  infaisables. S'il y a des problèmes, j'assume de te faire remonter les retours de production."*
  The owner's production feedback covers what they would have read.

### The evening of 2026-11-16

- **(21) The `1.7.0` stable ships tonight WITHOUT group calls**, which move to `1.7.1` as soon as they
  are read. This supersedes (15) for group calls only: the other large features and every reading
  still block the stable. The birthday morning-notice reading is taken on the stable the next morning.
- **(22) `docs/wiki/plan.md` is no longer tracked**: *"C'est exactement le genre de choses que
  j'entends par problème systémique de notre workflow... Peu importe la solution, je l'accepte."*
