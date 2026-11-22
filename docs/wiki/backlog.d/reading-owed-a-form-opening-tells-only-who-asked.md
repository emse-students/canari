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

**2026-11-21, dev, `1.7.3-alpha.4` (build `dev.5e1d3e4`), web seats only: PASS, with three gaps.** Organiser `beta` (W2), asker `third` (W4), non-asker `fourth` (W5), a form of the association "Club photo" opening 23:10.
`third` pressed "Me prévenir" (the button turned to "Rappel activé"). Moving the opening to "now" and pressing "Publier les modifications" was refused on the page: "1 personne a demandé à être prévenue de l'ouverture de ce formulaire : en avançant l'ouverture à maintenant, elle sera prévenue tout de suite...", the button reading "Publier et prévenir". Pressing it published; `third` alone got a bell row "Club photo « ... » est disponible", drawn with the association's logo (`alt` "Club photo") and name, not "Canari"/"CA"; `fourth` got no row. Then the opening was moved to 22:30: a row "ouvre dans 5 minutes !" appeared at 22:25 and, after 22:30, the same bell showed one "est disponible ... just now" row (the older row is replaced, not duplicated).
**Gaps:** (1) no push was read (web seats, no device for `third`); (2) a later move is not refused, so the "à la nouvelle ouverture" wording was not seen; (3) the sentence is French for a reader whose interface is English.
