## Reading owed - a form's respondent account fields, on a phone and on the web (owner, 2026-11-16)

target: 1.7.0

Built ([forms](../frontend/modules/forms.md#the-respondents-account-fields-owner-2026-11-16)):
an organiser ticks, per form, which of Nom, Prénom, E-mail (a public form's guests), Promo et
formation, Statut élève / personnel, Campus travel with each answer ("Qui a répondu", under the
advanced settings). A member of a named form has them read from the account at submit time and
stored as a snapshot (migration 174), and is told which before sending; a guest, or any respondent of
an anonymous form, is asked them instead; the organiser reads them as columns of the responses list
and the XLSX export, with a filter by promo, formation and status.

The reading that closes it, on the `1.7.0` pre-release, on the Mi 9T, the iPhone 12 and the web:

- the editor: the six boxes on a public form, five on a named one, three on an anonymous one; a new
  form starts with Nom and Prénom ticked; a form saved before it opens with its names ticked;
- the respondent notice on a named form lists exactly the ticked fields, and a test account's answer
  carries its own promo, formation, status and campus in the responses list (two cursus shown both);
- a guest on `/f/:id` and a member on an anonymous form are asked the declared fields, and refused
  until they answer them;
- the responses list's columns and the promo / formation / status filter; the XLSX export's columns,
  opened in a spreadsheet;
- an export from the store build BEFORE `1.7.0` on such a form: the expected 400, worded by the page.

**Mi 9T and one web seat, 2026-11-17 (`1.7.0-alpha.7`, dev), the named-form half READ** ([readings](../device-verification.md#the-mi-9t-readings-of-2026-11-17-170-alpha7-the-envoyer-a-retakes-on-section-22s-screens)): a personal named form made by `beta` on the web: the editor offers five boxes (Nom, Prenom, Promo et formation, Statut eleve / personnel, Campus), a new form starts with Nom and Prenom ticked and the three others ticked by hand. On the Mi (`alpha`) the notice read "Transmis a l'organisateur avec votre reponse : Nom, Prenom, Promo et formation, Statut eleve / personnel, Campus" (a second form with the default read "Nom, Prenom"). The answer reached `beta`'s responses list with the account's own values (2024 ICM, Eleve, Saint-Etienne) and the promo / formation / status filters were there. **Left:** the six boxes of a public form and the three of an anonymous one, a guest on `/f/:id`, the XLSX export opened in a spreadsheet, the store build before `1.7.0` (the expected 400), and the iPhone and web respondent halves.

**iPhone 12, 2026-11-17 (`1.7.0-alpha.7`, [readings](../device-verification.md#ninth-sitting-continued-the-alpha7-code-the-institution-form-the-live-bars-trends-rotation-frame-timing)), the editor half `PASS`:** the public draft shows six boxes (Nom, Prenom ticked), public off gives five; the anonymous variant could not be toggled on the iPhone's draft. Not read there: the respondent notice, the columns, the filter, the export.

**Web and iPhone 12, 2026-11-18, sitting S6 (`1.7.0-alpha.12`, [readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)): everything but the pre-`1.7.0` export READ, `PASS`.** `beta` (W2) made a public form (six boxes, Nom and Prénom ticked at start, all six ticked) and an anonymous one (three boxes: Promo et formation, Statut, Campus, none ticked at start). A signed-out guest (an isolated browser context) on `/f/:id` was asked Nom, Prénom, E-mail and the four "À propos de vous" fields, refused with "Ce champ est obligatoire." and no request until each was given, then `POST /api/public/forms/<id>/submit` 200. `alpha` (W1) and `gamma` (iPhone 12, the form opened from a link in a DM) each read "Transmis à l'organisateur avec votre réponse : Nom, Prénom, Promo et formation, Statut élève / personnel, Campus" (E-mail is a guest's field) and their rows carry the account's snapshot (`source: account`, 2024 ICM, student, Saint-Étienne). On the anonymous form `alpha` was asked the three, refused until they were answered, then `201`; the row has no user id, the day only, `source: declared`. The responses list: columns Nom, Promo et formation, Statut, Campus, the guest marked "Invité"; the "Année d'entrée" filter at 2025 left the guest alone. The Excel export (`/api/forms/<id>/export?format=xlsx` 200) parsed (no spreadsheet application on the bench; its OOXML read directly): Date & heure, Prénom, Nom de famille, Invité, E-mail, Année d'entrée, Formation, Statut élève / personnel, Campus, the question, one row per answer with the values above. Not read: "two cursus shown both" (no bench account has two). **Left: an export from a store build before `1.7.0` (the expected 400), on the Mi 9T's older install.**
