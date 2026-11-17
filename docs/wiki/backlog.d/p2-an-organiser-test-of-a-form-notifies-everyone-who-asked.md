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
