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
  local history there, and the app is never uninstalled.
- **The "Organisations" feed Back stays owed**, repeated with a history logger until three clean runs on
  `alpha.5` or the failure is caught.
- **Campus trends: the threshold becomes a server-side setting**, the production value unchanged and
  lowered on dev only.
- **Forms: an organiser chooses, per form, which respondent account fields are joined to each answer**
  (Nom, Prénom, E-mail, Promo et formation, Statut élève/personnel, Campus), each optional, building on
  the existing "Demander aux invités" block. The respondent sees what is transmitted; the answers list
  and the XLSX export carry the columns and a filter; a field that cannot come from an account (a
  guest, an anonymous form) is asked instead.

### Decided the evening of 2026-11-16

- **"Envoyer à..." has two paths, one review screen and one list**
  ([reels-in-chat section 22](../frontend/modules/reels-in-chat.md#22-the-two-paths-owner-2026-11-16)):
  from the CanaReels tab the review of a video offers "Publier" and "Envoyer à..."; from a
  conversation's camera the camera names the conversation, and the review offers "Ajouter des
  destinataires" (the same list, that conversation ticked) and the conversation's name, which sends
  there in one tap. The list's first row reads **"Publier"**, not "Publier sur CanaReels". **No save
  button** on the review. **No camera icon on the conversation rows.** **Community salons in the list
  move to `1.7.1`** ([reels-in-salons](reels-in-salons.md)).
- **A PHOTO taken in the CanaReels tab gets the same review as a video** ("Publier" / "Envoyer à...")
  and arrives as an ordinary image in the chosen chats (D-photo).
- **The `1.7.0` stable ships once every reading is taken**, even if that is tomorrow.
- **"Clore" on a form is hidden, and refused, before its opening date.**
- **"Rester connecté" is ticked by default in the apps and unticked on the web.**
- **The light pre-push keeps only the fast checks; the long suites run in CI only**
  ([cicd](../cicd.md#checks-at-commit-at-push-and-in-ci-only)).
- **An "Envoyer à..." reading the bench cannot stage falls under decision (20)** and is deleted with a
  dated line; a real defect it would have caught still blocks the flip.
- **The form close button ships in `1.7.0` only if it is merged before `alpha.7`**; otherwise it waits
  for the next version.
