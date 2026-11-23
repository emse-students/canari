## The owner's decisions of 2026-11-13

The owner handed the lead full autonomy after this day's questions: no further question is asked
until the owner is back. A new design question takes the recommended option when reversible (written
to the wiki) and is parked in [open-questions](../open-questions.md) when not.

### `1.6.11`

- The stable ships as soon as the phone readings pass. It ships an `alpha.5` carrying the
  scheduled posts (#3453, the owner wanted them in the next release), the room contact (#3452), the
  single minesweeper leaderboard (#3451), the Campus event mark (#3455), the XLSX export fix
  (#3456), the comment GIF fix (#3457) and the store notes (#3458).
- **A minor reading that fails** (cosmetic, no data loss): fix it, cut a new alpha, read it on both
  phones, then ship.
- PostgreSQL 18.7 (#3449) goes with the NEXT version, read on dev first; #3438, #3440, #3441 and
  #3190 are armed after the stable.

### Product decisions

1. **Read receipt in a DM**: under the newest message the peer read; it disappears once the peer
   has replied (kept as merged in #3450).
2. **Scheduled posts**: shown at the top of EVERY feed tab, to their editors only.
3. **An institution chooses the reach of each EVENT** as it does for each post: spaces and
   public, no default, never wider than its audience, an edit applies at once with no notification
   and no re-validation; for `1.6.12`.
4. **Article grids**: each grid has its own "Obligatoire" switch, OFF by default; the global "at
   least one article in the order" rule is REMOVED (*"Avoir des règles globales interdit des
   formulaires moins conventionnels"*); `1.6.12`.
5. **Editing a form answer**: a per-form setting, OFF by default; after payment the questions that
   touch the price are locked (no top-up, no partial refund); only while the form is open; never
   for an anonymous form or a guest; managers see "modifiée le"; `1.6.12`. The lead's reversible
   addition: a question granting a cotisation is locked once granted.
6. **Forms management**: `/forms` and the association's forms tab become ONE list ("le meilleur des
   deux mondes"); `1.6.12`.
7. **A Campus (neutral) event** shows a generic mark, never initials, and the PDF draws no mark.
8. **The event chip on a post** opens the GLOBAL agenda on that event.
9. **Lydia bridge (temporary)**: an association with a historical Lydia account collects on it until
   its Canari-enrolled Business is VALIDATED by Lydia, then switches by itself on
   `BUSINESS_VALIDATED`. The webhook is unsigned, so error 5 on the first real payment after a
   switch switches back and re-issues that payment on the historical account (the owner's explicit
   decision for this bridge). The historical key is kept for refunds. Managers see only the new
   account. The BDE's parked Business is put back as pending after the deploy; Le Cercle enrols
   itself.

### Calls and screen sharing - the order

- **Group calls (audio and video)**: the chantier right AFTER the slow-link chantier.
- **The SFU's network path**: TURN over TCP/TLS on 443, so nothing is asked of the school's IT
  department (the host drops outbound UDP); #2619 (webrtc 0.21) is the base.
- **Screen sharing**: LIVES first, before calls. A shared screen must still show the camera in a
  small inset (*"le partage d'écran doit quand même permettre d'afficher en petit la caméra"*).
