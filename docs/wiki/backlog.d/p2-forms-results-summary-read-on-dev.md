## P2 - forms: the per-question results summary is built, and its reading as a manager on dev closes it

target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

Built (G-RESULTS, owner, 2026-11-21): `GET /forms/:id/results` and the "Résumé" tab, computed by SQL
aggregates, with an anonymity floor of five answers per question and no cross-tab
([forms](../frontend/modules/forms.md#the-per-question-results-summary-g-results-owner-2026-11-21)).
What closes it, on a pre-release served on dev: open a form with a scale, a survey grid and a priced
grid as a manager and read each card against the responses table (counts equal, the denominator
sentence true, a multiple choice's percentages may pass 100 %); open an ANONYMOUS form of fewer than
five answers and see its questions withheld; read the tab as a member who answered and see the route
refuse. Production holds no scale or survey-grid question, so those two cards have been proven on the
real database only through the integration spec and literal rows.
