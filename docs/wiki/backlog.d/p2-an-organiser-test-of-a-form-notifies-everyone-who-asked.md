## P2 - an organiser can test a form only by opening it: "Tester l'envoi" in the preview (A)

target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**The rest of an entry whose other halves shipped (2026-11-21).** Seen on production, 2026-11-17: an
organiser moved a form's opening to "now" to try it, and everyone who had pressed the bell was told
it was open. What shipped closes the harm; [engagement L30](../engagement.md) is the mechanism:

- a FORM tells only the people who pressed its bell (no follower row any more, the rows an older
  build wrote are claimed and told nothing);
- moving a published form's opening EARLIER while people asked to be told is refused until the
  organiser confirms, the sentence naming how many (`409 FORM_OPENING_NOTIFIES`, "Publier et
  prévenir");
- a moved opening re-arms a stamp already spent, for every kind;
- the reminder's bell row and push name the association (its logo as the actor) and the form's title.

**Still owed - (A), "Tester l'envoi" in the preview** (owner, 2026-11-17, [decisions](../decisions/owner-decisions-of-2026-11-17.md)):
the organiser submits the form from its preview as a submission marked as a TEST - a sandbox or
simulated payment, counted in no seat (`seatHoldingWhere` excludes it), in no export or responses
list, and in no organiser alert - and the form is NOT opened, so nobody is notified. It was left out
of the pull request that shipped the rest on purpose: it is a column on `submissions` (a migration,
held for an adversarial review and a pass on dev) and a marker every reader of the table must skip
(seats, exports, the list, the organiser alerts, the payment callbacks, the refund sweep, the
reconciliation), and a missed reader counts a test as a real answer. Owed: the marker and an
audit that enumerates EVERY reader of `submissions`, the preview's button and its Paraglide strings
(fr/en), and a spec per reader. Until then the confirmation above is what stops a test from pushing
anyone: the organiser who still wants to try a form keeps its opening date, or accepts the count
the confirmation names.
