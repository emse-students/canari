## P2 - A promoted answer loses its place when its payment request cannot be issued

target: 1.8.0

**Today.** A waiting answer promoted on a paid online form becomes `payment_due` and is paid through
"Reprendre le paiement" ([forms](../frontend/modules/forms.md#a-waiting-list-on-a-limited-form-owner-decision-of-2026-11-23-180)). The resume turns the row `pending` with no request named,
then issues the request; when the issuing fails (Lydia unreachable, a refused business), the row is
released like any unissued request (`releaseUnissuedRow` in `apps/social-service/src/forms/forms.service.ts`:
`pending` -> `cancelled`), which is a freeing event, so the place goes to the next in line. The failure was
not the person's, and the owner's decision (item 16 of [2026-11-23](../decisions/owner-decisions-of-2026-11-23.md))
frees a place on a REFUSED or EXPIRED payment, not on one Canari could not ask for.

**The fix.** Carry the row's status before the resume to the release: a `payment_due` row whose request
was provably never issued (`origin: 'unissued'`, not `issue-unknown`, where a request may exist at Lydia
and a second one must not be issued) goes back to `payment_due`, keeping its hold. A service spec and the
integration spec (`waitlist.integration.spec.ts`) with the issuing call failing before it is sent.
