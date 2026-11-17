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
