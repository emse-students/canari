### Fixed - a form its manager closed is drawn closed on the member page, and the "Ferme" badge appears at once

The server now says whether a form is open (`windowState` on the reads and the close answer, one rule
with the refusals), so no screen compares a stored date with the phone's clock: the member page draws
the closed notice with no send, the list badge follows the close answer, and a refusal while the page
is open redraws it closed
([forms](docs/wiki/frontend/modules/forms.md#closing-a-form-by-hand-and-the-closing-date-owner-2026-11-16)).
