## Reading owed - a form tells only who asked, and an earlier opening asks first (2026-11-21)

target: 1.7.3

**What is built:** a form writes no follower row at its publication; moving a published form's
opening earlier while people asked to be told is refused `409 FORM_OPENING_NOTIFIES` until the editor
sends "Publier et prévenir"; a moved opening re-arms a spent stamp; the reminder's bell row and push
carry the association (actor, logo) and the form's title
([engagement](../engagement.md), L30). Proven by `opening-reminders.integration.spec.ts`,
`forms.service.opening-notify.spec.ts`, `push-content.spec.ts` and `publish.test.ts`; the integration
spec runs in CI only.

**The reading that closes it, on the first pre-release carrying it (dev):** account B follows an
association and presses the bell of its form opening in 1 hour; account C follows it and does not.
An organiser edits the form to open now and presses "Publier les modifications": the page refuses,
saying "1 personne a demandé à être prévenue... tout de suite" (and "à la nouvelle ouverture" for a date still ahead), the button reads "Publier et prévenir"; pressing it
publishes, B alone is pushed and sees a bell row headed by the association's name and logo with the
form's title; C gets nothing, no push and no row. Then the organiser moves the opening one hour later
after it fired: B is told again at the new opening. A fail is C told, no refusal naming the count, or
the bell row headed "Canari" / "CA".
