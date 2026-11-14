## The owner's decisions of 2026-11-14

target: 1.7.0

Recorded so no question answered here is asked again (owner: *"note mes réponses, je n'aime pas me
répéter"*). Each line names where its detail lives.

### Order of work

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
