## P2 - an organiser testing a form by moving its opening to "now" notifies everyone who asked to be told

target: 1.7.1

**Seen on production, 2026-11-17.** An organiser moved a form's opening to "now" to try it, and the
opening reminder ("Le formulaire est disponible - dépêchez-vous...", `form_reminder`, sent by
`forms-reminder.scheduler.ts`) went to everyone who had pressed the form's bell; the opening was then
moved back. Those people were told a form was open that was not, and there is no way to test a form
without opening it.

**The owner's decision, 2026-11-17: "A + B + affichage, en 1.7.1"**
([decisions](owner-decisions-of-2026-11-17.md)):

- **(A) "Tester l'envoi" in the preview.** The organiser submits the form from its preview as a
  submission marked as a TEST: a sandbox or simulated payment, counted in no seat
  (`seatHoldingWhere` excludes it) and in no export or responses list, and the form is NOT opened -
  so nobody is notified.
- **(B) Moving the opening earlier asks first** when people asked to be notified: a confirmation
  naming the count ("N personnes ont demandé à être prévenues..."), so the organiser knows the move
  sends them a push.
- **(display) The reminder names who and what.** The `form_reminder` bell row and push carry the
  association (its logo as the actor, not the generic "Canari" / "CA") and the form's title.

**Rejected: (C) notify only once the link "was distributed"** - the server cannot know when a link is
distributed, and a person who asked to be told must be told when the form really opens.

Owed with it: the test marker on the submission and every reader that must skip it (seats, exports,
the list, the organiser alerts), the preview's button, the confirmation on the opening's edit, the
reminder's payload and its bell row, the Paraglide strings (fr/en), and specs for each.

**The owner's second decision, the same day: a form notifies only the people who asked.** *"Je ne
pense pas que les formulaires doivent notifier les gens (sauf quand ils ont cliqué sur la cloche du
formulaire)."* So a FORM's opening no longer writes `followed` rows for the association's followers
(`announceOpeningToFollowers` in `forms.service.ts`, kind `form`, `apps/social-service/src/openings/opening-reminders.ts`):
no push and no in-app row for them. Only an `asked` row - written when the person presses the form's
bell, "Me prévenir" - is told: the 5-minute heads-up and the opening. **Events and booking spaces are
untouched by this decision**: their openings still announce to followers
(`associations.service.ts`, `booking-spaces.service.ts`). Charter: principle 3 (your attention is not
for sale).

**A defect found on production the same day: a moved opening does not re-arm a stamp already
spent.** When a form's opening is moved LATER after it had already opened, the follower rows keep
`notifiedOnOpen = true` and the old `opensAt` (their write is `ON CONFLICT DO NOTHING`), so the real
opening tells nobody; an `asked` row is re-armed. With the decision above, followers get no row for a
form at all, but the rule stands for every kind: **a moved opening must re-arm whatever has not really
opened** - the `asked` rows, and the follower rows of events and booking spaces - from the new
`opensAt`, with a spec moving an opening later after it fired. The 2026-11-17 case was repaired by
hand on production with the owner's yes; nothing else was touched.
