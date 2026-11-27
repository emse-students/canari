## The owner's decisions of 2026-11-27

Recorded so no question answered here is asked again. All three ship in `1.8.3`, in one pull request
(the MinoWiki gate and the retirement of Archives MINO, [mino-access](../infrastructure/mino-access.md)).

1. **MinoWiki is gated exactly like MiGallery and Le Cercle** (owner, 2026-11-27): the same policy
   `miconnect-access-window-post-or-cotisant`, a group `acces-mino-wiki`, `policy_engine_mode: any` -
   D43's shape, one policy for the three sites. The lead added a third binding so the wiki's own
   administrators and editors (the `mino-*` groups) are never locked out by it
   (`miconnect-mino-wiki-roles`; [profiles-and-access](../profiles-and-access.md),
   [mino-access](../infrastructure/mino-access.md#who-may-enter-the-same-cotisant-gate-as-migallery-and-le-cercle-owner-2026-11-27)).

2. **Archives MINO is retired** (owner, 2026-11-27): its content is in MinoWiki. Its application and
   provider are deleted by `state: absent` entries; the logout redirect MinoWiki shared with it is
   renamed and pointed at the wiki; the `301` container and the public name go after the stable
   ([mino-access](../infrastructure/mino-access.md#archives-mino-is-retired-2026-11-27)).

3. **A minor change to the MiConnect terms asks nobody again, and the notice is the minimum** (owner,
   verbatim: *"Nouvelle version en 1.8.3. Pas la peine de faire réaccepter les modifications mineures,
   et tu peux réduire le texte au minimum (tout en gardant le lien pour avoir le détail complet), ça
   rajoute une étape qui ajoute de la friction pour rien"*). Charter principle 7, *simple, léger,
   agréable* ([principes](../../principes.md)): a page shown again for a correction is friction with no
   information the person needs; principle 1 is untouched, since nothing here is about messages and
   the full text stays one tap away.
   - **Two dates, two meanings.** `/legal/miconnect` carries `updated`, the date of the text's last
     revision, and `acceptedVersion`, the version a person accepts. A MATERIAL change (a new kind of
     data, a new purpose) moves both, and the version literal of `45-consent.yaml`, so every account
     is asked once; a MINOR revision (a service retired, a wording made precise, a recipient added
     under rules the text already describes) moves `updated` alone. `check-consent-version.sh` pins
     `acceptedVersion` to the other four places and refuses an `updated` earlier than it.
   - **The lead's reading of "minor"** (lead, 2026-11-27, reversible): adding a RECIPIENT that receives
     data ONLY for the people who themselves sign in to it (the MDE network console, a new site behind
     MiConnect) counts as minor - it adds no data and no purpose for anyone who does not use it.
     Section 8 of the page says so in its examples. A new kind of data or a new purpose stays material.
   - **This revision is minor**: the version stays `2026-11-24`. The full text now names the wiki
     among the sites the cotisant rule opens, drops the archives, and names the MDE network console
     and what it receives; the notice is two sentences and the link. **An existing account that
     accepted `2026-11-24` sees nothing at its next sign-in**; an account that has not accepted it
     yet meets the shorter notice. Shrinking the notice needs no version to take effect: the notice
     is read at every display of the stage.
   - **Where it is written:** the register of processing (MiConnect, section 3) and the page itself
     (sections 6 and 8); Canari's own privacy policy does not describe MiConnect's terms and is
     unchanged.

## A reading the lead can take is taken, not left owed (owner, 2026-11-27)

*"Et les lectures, qu'est-ce que tu attends pour les faire ? Avoir des lectures en attente est
foncièrement mauvais si tu as le pouvoir de les faire (ce qui est quasi tout le temps le cas). Note le"*

- **A reading owed is a defect of the plan, not a state.** The bench phones (the Mi 9T and the
  iPhone 12), every test account and its PIN, dev, the web and production read-only are the lead's:
  a reading they can take is taken as soon as the build it reads is installed - the same day as the
  pre-release, by agents working in parallel (one per phone, one for the web and the servers).
- **Only a reading that truly needs what the lead does not hold stays owed**: the owner's own phone
  or account, a person's real hand where no test account can stand in, hardware the bench lacks. Its
  entry says which, in one line.
- **A pre-release is followed by its readings, not by a wait.** The plan's "Readings owed" checklist
  is emptied before the next pre-release is cut whenever the bench can do it.
