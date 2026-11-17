## Reading owed - closing a form from the list, the respondent sees "ferme", the form reopens

target: 1.7.0

Built (owner, 2026-11-16, "un bouton pour clore le formulaire"): `POST /forms/:id/close` and
`/reopen`, the "Clore le formulaire" / "Rouvrir" entries of the list row's menu, the "Ferme" badge, and
the optional "Date de cloture" in the editor
([forms](../frontend/modules/forms.md#closing-a-form-by-hand-and-the-closing-date-owner-2026-11-16)).

The reading, on the `1.7.0` pre-release on dev, with two accounts:

1. A manager closes a published form from `/forms` (the menu, then the confirmation): the row shows "Ferme"
   and no "Modifications non publiees".
2. A second account opens the form link (and, for a public form, a signed-out browser): the page says
   "Ce formulaire est ferme" and sends nothing; the link preview says "Ferme".
3. The manager picks "Rouvrir": the badge goes and the second account can answer.
4. In the editor, a closing date before the opening date is refused under the field and at the save.

**Mi 9T (respondent) and one web seat (manager), 2026-11-17 (`1.7.0-alpha.7`, dev):** step 1 `PASS` (the menu swaps to "Rouvrir" at once; the "Ferme" badge shows once the list is re-entered); **step 2 FAILS on the member page**: the closed form is drawn open and refused only at "Envoyer" (`FORM_CLOSED`, "Ce formulaire est ferme." after the press) - fixed on the branch `fix/member-form-page-closed` (the server states `windowState` on the reads and the close answer, one rule with the refusals; the member page draws the closed notice and no send, the list badge follows the close answer); the public page `/f/:id` was not read (no signed-out browser seat); step 3 `PASS` (after "Rouvrir" the answer was accepted, 201); step 4 (closing date before opening, web) not read. The entry stays until, on the pre-release carrying the fix, **re-read on the Mi 9T**: step 2 (the member page says "Ce formulaire est ferme", no "Envoyer") and the "Ferme" badge appearing the moment the close answers, a manager closing the form while the respondent has it open and pressing "Envoyer" (the page redraws closed, nothing sent), with the "Reponses" panel open; and the public page `/f/:id` signed out.

**iPhone 12, 2026-11-17 (`1.7.0-alpha.7`, [readings](../device-verification.md#ninth-sitting-continued-the-alpha7-code-the-institution-form-the-live-bars-trends-rotation-frame-timing)), the manager half of step 1 and 3 `PASS`:** the list menu offers "Clore le formulaire", the confirmation, the toast "Formulaire clos." and the badge "Ferme"; the menu then offers "Rouvrir le formulaire" and the badge goes. The respondent page (step 2) could not be read: the form routes redirect on the iPhone's seats. Unchanged: the entry stays for step 2 and step 4.

**Mi 9T (respondent), two web seats (manager, second respondent), 2026-11-17 (`1.7.0-alpha.8`, [readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha8-both-phones-one-sitting)): the re-read `PASS` except two steps.** The "Ferme" badge drew 0.7 s after the close, no list re-entry; with the form open on the Mi and an answer typed, "Envoyer" after the close got `400 FORM_CLOSED` and the page redrew "Ce formulaire est fermé." with the field and "Envoyer" disabled, nothing sent; a fresh open read closed with no send; "Rouvrir" took the badge away and the answer went (201). **The end instant (#3776):** a closing date of 13:40 Paris; past it a second account's fresh page read "Ce formulaire est fermé." with "Envoyer" disabled, the server answering `windowState=closed` with `closedAt` the instant, and the manager's badge "Fermé". **Left:** step 4 (a closing date before the opening date) and the public page `/f/:id` signed out; the "Réponses" panel was not open during the close.
