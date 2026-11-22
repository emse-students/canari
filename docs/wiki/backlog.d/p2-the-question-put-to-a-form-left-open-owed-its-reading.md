## P2 - the question put to a form left open: built, owed its reading and its day-one count

target: 1.8.0

**What is built** ([forms](../frontend/modules/forms.md#the-question-put-to-a-form-left-open-owner-2026-11-21-migration-180)):
the closing date offered at publication, and the daily sweep that asks the owner and the `MANAGE_FORMS`
holders ONCE whether to close a form left open for 21 days (bell row `form_stale_open`, floor `1.8.0`,
migration 180). Decision of the owner, 2026-11-21; charter principle 3.

**The card and the bell row need a client >= 1.8.0** (floor `1.8.0`): they will not be seen on the 1.7.3
alphas, so this reading waits for the first 1.8.0 pre-release.

**Owed, on the first 1.8.0 pre-release (dev):** an open form with no answer for 21 days (backdate it on
dev, ids to the allowlist) is asked about at 09:30 Paris time the next day: each `MANAGE_FORMS` holder of
an association's form (the owner of a personal one; NOT an association creator without the flag)
gets ONE bell row, no push; the card on `/forms?responses=<id>` offers Fermer, Garder ouvert and
Fixer une date; each answer takes the card AND the bell row away; a second sweep asks nothing; a new answer
followed by 21 silent days asks once more. A fail is a second row, a push, or a row surviving its answer.
**On production, after the stable:** the first sweep should claim the 7 forms measured on 2026-11-21
(20 rows, 12 people, to be re-measured the day before).
