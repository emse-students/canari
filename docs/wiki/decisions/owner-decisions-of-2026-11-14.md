## The owner's decisions of 2026-11-14

Recorded so no question answered here is asked again (owner: *"note mes réponses, je n'aime pas me
répéter"*). Each line names where its detail lives.

### Order of work

- **Every owed reading reaches zero before a new alpha** (*"Finis toutes les lectures en attente
  avant d'en ajouter de nouvelles avec une alpha. Les 200 datent, donc elles sont toutes faisables ou
  supprimables. Une fois que tu es à 0, là on peut continuer."*): each one is read (a FAIL becomes a
  defect) or deleted with its reason, never left waiting
  ([durable-rules](../durable-rules.md#release-and-ci---cicd)).
- **The owed readings first, in backlog order.** *"Ordre du backlog, c'est-à-dire toutes les lectures
  d'abord."* Everything that can run in parallel runs in parallel (*"Lance tout ce qui est possible
  en parallèle"*), and the lead asks for an authorization up front where a refusal is likely.
- **Authorizations for the readings campaign, until it ends:**
  - read-only ssh on production and dev (SELECT, container logs, `curl -I`), never a write;
  - the local estate on the lead's workstation is the lead's (start, stop, delete its test volumes);
  - on the bench phones only (Mi 9T, iPhone 12): install, uninstall, wipe the app's data, reboot;
  - dev writes by test accounts for a reading are allowed, and cleaned up afterwards; the test DM
    between the two bench test accounts is kept;
  - the lead arms a readings pull request himself once reviewed and green.
- **Owner-only readings:** #1 (zero-tap restore on a second Android phone) dropped (*"On zappe"*);
  #106 and #132 (Lydia in production, the historical bridge) validated by the owner; #142 (the
  deleted placeholder's leaf) closed as unanswerable; #182 (WebView debugging off in release) read by
  inspecting the release APK; #174 (iOS push rows) read by the lead on TestFlight; #93 (desktop
  screen share in a live) read together, live.
- **Leftover worktrees and background processes:** clean them (*"Oui, regarde et nettoie"*).
- **`1.6.12`:** published, and its Lydia return read in production at the first real payment; the
  dev Lydia account is re-linked by the owner by hand.

### Privacy: the server knows as little as possible (principle 1)

- *"J'aimerais que le serveur sache le moins possible de choses, et le moins possible de choses en
  clair."* The inventory of what the servers still hold in clear, why, and what can move to the
  device is server-knowledge-inventory (being written).
- **Notifications are composed by the device, never by the server.** *"Tout pourrait être donné par
  l'appareil et rien par le serveur, ce serait plus homogène."* No server push path reads a nickname.
- **Nicknames reach notifications, all of them, as on Messenger** - this reverses the 2026-11-08
  rule ([chat](../frontend/modules/chat.md#per-conversation-nicknames-modifier-les-pseudos-2026-11-08)).
  *"Il ne connaît bientôt plus rien non ? J'aimerais comme sur Messenger, tous les pseudos."* Blocks
  still hide a nickname from its target, in a notification as on the screen.

### Lydia contract counter (#3506)

- Every contract value (yearly flux target, VAT, fees, bands, margins) is a **platform admin
  setting**, never in the repository (*"Tout dans réglages admin, marges comprises"*).
- Only Businesses **enrolled through Canari** count, never the historical bridge accounts.
- Flux = **paid minus refunds**, VAT included; fees shown VAT included with a short notice.
- **No "environ"**: the payer sees only the price; the association sees the price paid and, smaller,
  the net. The fee schedule is shown only to those who manage prices (shop, forms...).
- The admin sees **which association** each part of the total comes from.
- A paid answer **cannot be deleted**, and the vendor account is kept on the purchase record, so it
  survives the deletion of a form.
- Only members holding **"gérer les formulaires"** manage an association's forms.
- No seeded anniversary date (*"Non, retire-la"*).
- Migration 168 approved by the owner (*"J'autorise explicitement"*), its approval line added by the
  lead after the second review.

### Lives (#3508) and forms (#3504)

- Lives: ready-made scenes; the overlay is dragged and snaps to a corner; desktop first; mic and
  camera mute and a "Je reviens" screen; stopping the share from the browser's bar goes to "Je
  reviens"; a fixed output size, so a resized window never corrupts the stream; the preview shows
  exactly what is sent, black borders included ([live](../frontend/modules/live.md)).
- Forms: the submitted footer's status and edit link sit on one line; the payment wording appears
  only on a paid form.

### Content-free push - the order (answers of the afternoon)

- **The wake mode is switched on (dev, then production, Android) only AFTER all the owed readings**,
  not right after the Mi 9T reading (owner chose "Après toutes les lectures").
- **iOS: one iPhone 12 reading replaces the withdrawn P1 iOS-notifications entry as the gate** for
  `PUSH_WAKE_DECLARED.ios` - notifications received with the app killed, in wake mode on dev. That
  entry was withdrawn on 2026-11-03, so the old condition could never be met.
- **Step 2's Android client (WP-W4: salons, social, bell) is built after the readings**, not in
  parallel.
- **A salon notification names the author of each line, resolved by the device** from the sender
  id (profile name, or nickname), never carried by the push - closes the "naming the author of each
  line inside a salon's stacked notification" decision of
  [open-questions](../open-questions.md).

### Other open questions answered

- **#3526 (an erased account leaves the carte): the lead republishes every live carte ONCE, right
  after the release that carries it** - no migration; that publish drops the accounts erased before
  #3526 and the legacy line-only directory entries. The gesture, who can make it and how to check it:
  [carte-vie-asso](../carte-vie-asso.md#after-the-release-that-carries-3526-republish-every-live-carte-once).

- **CanaReels cover every short or vertical video, from the camera AND the gallery** (owner: *"Toute
  vidéo verticale et/ou inférieure à 90 s est un CanaReel, y compris depuis la galerie"*); the feed
  CanaReel retention is already **one year** (`REEL_RETENTION_DAYS = 365`, owner 2026-11-09) - the
  open-questions entry that still said 30 days was stale. Asked next: whether every retention
  duration should live in the admin settings, kept in line with the privacy policy.
- **An institution's "Personnel" public reaches every staff account of the ticked spaces' campuses**
  (staff by campus) - closes that open question
  ([profiles-and-access](../profiles-and-access.md#an-institutions-reach-per-post-as-built-owner-2026-11-10)).
- **A device that dropped a frame says nothing to the user** - the loss stays reported on the
  server and in the logs; closes "Should a device that dropped a frame say so?".
- **Read receipts keep today's shape** (the first mark at once, the next ones coalesced over 2 s) -
  closes the read-receipt decision; the window's only failure cost is traffic, never a lost receipt.
- **Which video is a CanaReel: vertical OR 90 s or shorter** (a short landscape video, shown with bars,
  and a long vertical one both are), from the camera or the gallery.
- **Retroactive: every gallery video already posted becomes a CanaReel that expires one year after
  its publication** (owner chose "Oui, toutes", knowing the ones older than a year then go at once) -
  a held, destructive migration.
- **Every retention duration becomes a platform admin setting, and the privacy policy renders the
  values in force from the same source**, so the two can never disagree; a lowered duration applies
  to new content only.
- **#3506: an association's form whose author lacks "Gérer les formulaires" leaves that author's
  hands** (1 of 15 live forms in production); the association's managers keep it and can grant the
  permission back.

### The privacy chantier - "the server knows as little as possible"

- **Order, after the readings:** (1) content-free push (Android, then salons and social, then iOS);
  (2) DM reactions travel as an MLS frame, never as a plaintext push side channel; (3) salon
  mentions computed on the device; (4) shorter retention durations; (5) group and community photos
  encrypted, ALL of them (owner: *"Oui, toutes"*); (6) group names encrypted; (7) a sealed community
  state - name, photo, salons, role labels and community nicknames, read by members only;
  (8) **cross-signing of a user's devices** - a user's devices vouch for one another, so a device
  can no longer be passed off under a member's self-asserted user id; designed in the wiki first,
  after step 7. #3519 merges without it
  ([mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)).
  Steps 2 to 5 are independent of one another.
- **There is no community directory**: a community is entered only by an invitation or a member's
  opaque invite link (`/c/join/<token>`). Nothing forces any community name or photo to stay public,
  and the internal `slug` (derived from the name, never shown in a link) goes with step 7.
- **The people directory stays on the server** (names, promo, campus, formation from MiConnect): it
  is how a person is found, and every audience rule reads it.

### Audiences - the audit's questions (asked by the auditing session, same day)

- **The signed agenda link follows the app** (*"Respecter les publics"*, *"Aligner le lien sur
  l'app"*): a subscription link serves only what its holder sees in the app, is bound to the account,
  stops when the account is erased or the holder revokes it; links already handed out keep working,
  filtered the same way. Replaces "membership does not matter" (2026-10-06). To build.
- **The portail's directory is filtered for every type** (*"Filtrer comme les assos"*): a list or an
  institution whose audience does not reach the portail's space is left out, like an association
  ([anonymous-surface](../anonymous-surface.md)).
- **A nominative read grant opens everything of its cell**: beside the posts and the agenda, the
  association directory, the shop and the partnerships of the ticked cell - *"elle pourrait même
  payer le tarif cotisant si elle cotisait"*. No per-person switch. Built
  ([as built](../profiles-and-access.md#a-grant-opens-everything-of-its-cell-owner-2026-11-14)):
  a partnership card listed to a named reader is one they may claim (confirmed by the owner: *"Oui,
  comme un etudiant"*, limited stock included), and an association's booking spaces open the same
  way (*"Ouvrir aussi"*).
- **An unknown formation at sign-in is ignored and said** (*"L'ignorer et alerter"*), never filed
  under `Autre`: the cursus entry is kept (it is what tells a student from staff), opens no space,
  and is logged.
- **The published carte stays a snapshot** (*"Laisser la photo"*): nothing is withdrawn from it
  between two publications.
- **The anonymous link preview of a post stays as it is** (*"Garder l'aperçu"*).
- **Staff in the app** (agenda, shop, partnerships, directory of their campus): NOT opened by campus;
  the read grant above is the door.

### An entry no member made - the device decides (#3519)

- **The proof is on the device**, never the server's roster (*"Preuve sur l'appareil. mais il faut
  un truc solide, robuste, et résilient"*): each device records who it saw hold a leaf of each
  conversation, in its sealed MLS state
  ([mls-protocol](../protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23)).
- **Retired is not proven** (*"Retiré = non prouvé"*): a commit by ANOTHER member that removes every
  leaf of a user cancels that user's proof, so their later entry alone is not proven; a user
  removing their own device cancels nothing. Since a user's last leaf always leaves through another
  member's commit, every self-admitted entry of a user absent from the tree is reported
  `new-person` in practice; the way back is a member's Add.
- **Cross-signing of a user's devices is step 8 of the privacy chantier** (above), which closes the
  impersonation of a past member.

### The colour of neutral "Campus" events (#3539)

- **Each BDE chooses the colour of its neutral events** (recorded from the body of #3539, where the
  decision was written on the day): the fixed `campus`-derived yellow goes; the holders of
  `EDIT_PROFILE` (who already edit the association's colour and logo) set it; no choice keeps the
  derived accent ([calendar](../frontend/modules/calendar.md#the-colour-of-neutral-events-is-the-bdes-choice-owner-2026-11-14)).
- **The masking cost is the lead's reversible call, not an owner answer:** the colour rides every
  neutral row, so on a campus with two BDEs that chose different colours it hints which one filed an
  event; the review of #3539 removed the stronger leak (the colour is in no member read, so nobody can
  look it up against the associations). Reverting is dropping the field from the rows.

### Answers of the afternoon (relayed by the lead, same day)

- **A reading of code not yet shipped is not owed:** *"supprime simplement du backlog, on rajoutera
  quand ce sera nécessaire"*. Each such reading is dropped, and the reading is written again when its
  code ships in a stable. The check is the merge commit being an ancestor of the latest stable tag.

- **#3519, a returning member of an encrypted group:** *"Preuve sur l'appareil. mais il faut un truc
  solide, robuste, et résilient"* - the device, never the server's roster, decides that a member is
  returning; #3519 is reworked before it merges. Its consequence is accepted: *"Accepter jusqu'à
  l'étape 8"* (cross-signing). A person whose only phone is replaced, and whose old phone another
  member's commit removed, is reported "non prouvé" on returning alone and needs a member's Add. The
  count of those alerts (`[UNINVITED_ENTRY]` new-person lines carrying `watched_from`) decides whether
  step 8 comes earlier.
- **#3518, the 18 departed seats removed (migration 051):** accepted with its costs - a departed
  person's re-add is refused, a later erasure no longer ends the 1:1, 11 two-member conversations are
  concerned. It ships after an alpha on dev, once the readings are at zero.
- **The agenda's signed link:** *"Aligner le lien sur l'app"* - links already handed out keep working,
  filtered the same way.
- **Lydia:** the bridges are opened for the BDE and Le Cercle (*"Oui, ouvre-les"*); the BDE's started
  enrolment is restored as pending (details in the private notes).
- **Readings #8, #89, #127:** #8 closed with the measurement taken; #89 read with a temporary iPhone
  passcode, removed afterwards; #127 deleted (*"Supprimer, livraison prouvée"*).
