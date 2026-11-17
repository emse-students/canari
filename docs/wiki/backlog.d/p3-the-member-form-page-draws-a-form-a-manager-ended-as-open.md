## P3 - the member form page draws a form its manager ended as open, and refuses only at "Envoyer" (read on the Mi 9T, 2026-11-17)

target: 1.7.0

Found by the reading of [closing a form by hand](reading-owed-closing-a-form-by-hand.md), step 2, on
`v1.7.0-alpha.7` (dev, the Mi 9T as the respondent). The form (a named, personal one) was closed from
the manager's list ("Clore le formulaire", confirmed; the menu then offers "Rouvrir"). The respondent
opened its link in the app AFTER the close: the page fetched the form fresh (`GET /api/forms/:id`
200, then `/check`) and drew it OPEN - the question, "Transmis a l'organisateur ...", "Envoyer", no
notice. The answer was refused only at the press: `POST /api/forms/:id/submit` 400, `code=FORM_CLOSED`,
and the page then said "Ce formulaire est ferme." (`form_refusal_closed`). After "Rouvrir" the same
answer was accepted (201).

Nothing is stored, so the entry's "sends nothing" holds, but the member types an answer into a form
that cannot take it. The cause is visible in source: the closed state ("Ce formulaire est ferme.",
`form_view_closed`) is drawn only by the PUBLIC page, `routes/f/[id]/+page.svelte` (`isClosed`); the
member page `routes/forms/[id]/+page.svelte` never reads `closedAt`. Fix: draw the same notice (and no
"Envoyer") on the member page from the form's own `closedAt`, with a component test beside the
public page's; then re-read on a phone.

Also seen, smaller: with the "Reponses" panel of a list row open on the manager's web seat, closing
the form swaps the menu entry to "Rouvrir" at once but the "Ferme" badge appears only after the list
is left and entered again.
