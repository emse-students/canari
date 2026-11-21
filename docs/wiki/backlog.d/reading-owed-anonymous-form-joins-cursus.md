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
