## A capped form may hold a seat for 10 minutes behind a "Réserver ma place" button (owner, 2026-11-17: "Plus tard (1.8.0)")

target: 1.8.1

**Today.** A seat of a capped form is counted at submit, under the form's lock: the submission's
transaction counts the rows that hold a seat (`seatHoldingWhere`, `apps/social-service/src/forms/seat-hold.ts`
- paid, free, a live online-payment `pending` younger than its 30-minute hold, `pending_cash`) and refuses
past the capacity ([forms](../frontend/modules/forms.md#an-online-payment-holds-its-seat-for-30-minutes-and-a-late-one-is-decided-from-the-row-2026-10-15)).
A person filling a long form can therefore lose the last seat to a faster submitter.

**The design kept for `1.8.0`: a hold behind an explicit button.** A "Réserver ma place" button on a
capped form writes a PENDING row for the signed-in person; `seatHoldingWhere` counts it for 10 minutes,
like the online payment's hold; one hold per signed-in person and form (a second press returns the same
row); the form shows a countdown, and the submit turns the hold into the answer under the same lock. A
hold that expires frees the seat with no sweep (the count reads its age). A guest of a public form has
no account to hold for, so it submits as today.

**Rejected the same day: a hold taken at OPENING the form.** Every browser that opens it would block a
seat - a link shared in a group fills a small form with people only reading it - and a script can open a
public form as many times as it has seats and hold all of them. The button keeps the hold an intention
of a signed-in person, one per account.

Owed with it: the client (button, countdown, the expired state), the Paraglide strings (fr/en), the
service and integration specs of the hold's count and its expiry under the lock.
