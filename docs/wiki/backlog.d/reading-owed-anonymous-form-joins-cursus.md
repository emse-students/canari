## Reading owed - an anonymous form that reads the cursus from the account

target: 1.7.3

Built (owner, 2026-11-21: "Oui, en option, avec avis"): the box "Promo et formation lues sur le compte
(certifiées)" on an anonymous form, the member's notice before sending, the snapshot
`{ source: 'account', cursus }` and the refusal of a name, status or campus
([forms](../frontend/modules/forms.md#an-anonymous-form-may-read-the-cursus-from-the-account-owner-2026-11-21)).
The admission route (Classique / Fusion / AST) stays an organiser question, not a profile field.

**The reading that closes it**, on a `1.7.3` pre-release (the floor that announces the join): on dev, an
anonymous form with the box ticked and "Statut" asked; as a member on a phone, read the notice, see that
only the status is asked, send, and read the manager's list (promo and formation present, no name);
then as a guest on the public link, see the cursus asked. An older build (`1.7.2`) on the same form
must be asked the cursus and log `[LEGACY]`.

Also read: with the form open on the phone, tick another box on the live form from the web, then
press "Envoyer" - the page must say the form changed, redraw the notice with the new field, keep what
was typed, and send on the second press (named form and anonymous form alike).

**2026-11-21, on `1.7.3-alpha.1`: PASS** - on the web, the refusal and the reload (submit `POST`
400, then the reload `GET` 200, the notice redrawn with the new field, the typed answer kept, the
second submit 201); the same refusal and reload on the iPhone; on the iPhone the notice shown, no
cursus question, the submit accepted; on Android the notice shown and no cursus question; the
manager's list and the xlsx export carry a Source column (`compte` / `déclaré`) and no name column;
a guest answer through the public API reads `déclaré`. Then on the Mi 9T (sitting r173a2), Android **PASS**: the phone submit succeeded, its notice saying
the promo and formation are read from the account, and the manager's list shows source `compte`;
with the joined fields changed on the live form, the first "Envoyer" showed the changed-form message,
the notice was redrawn, the typed answer kept, and the second press succeeded. **2026-11-21, on `1.7.3-alpha.2` (`/api/version` build `dev.69fee4a`): the guest PAGE PASS** - fresh isolated
browser context, no session, public link `/f/<id>` of the public anonymous form: it opens without an account; the
"Promo et formation lues sur le compte" option is absent for a guest (the page says the cursus is asked by the
organiser and declared by the guest, not read from the account); a guest submission (Formation ISMIN, year 2025)
`POST .../submit` 200 and "Reponse envoyee, merci"; the console holds only `[debug]` lines, no error, no warning.
**Every row has now passed:** the entry is deleted when 1.7.3 ships.
