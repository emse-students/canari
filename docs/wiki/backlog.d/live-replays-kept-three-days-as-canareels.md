## Live replays - a finished live is kept three days and shown as a CanaReel (owner, 2026-11-07; designed and decided 2026-11-09, WP-R1 built)

Asked by the owner on 2026-11-07, every question answered the same day:

- **Retention**: a finished live is kept and watchable for **3 days**, then deleted.
- **Always kept**, and *"il doit apparaitre comme un Reel dans les feed et l'onglet CanaReel"*: the
  replay appears as a CanaReel in the feeds and in the CanaReels tab, to the audience that could
  see the live. A live cut by moderation or ended by an erasure never becomes one (lead decision).
- **Download**: the same rules as downloading a Reel today, for whoever may see the replay.
- **The live chat is not replayed**: video only, the chat stays ephemeral.
- **And a review of what a CanaReel is** (*"il faudrait qu'on revoie ce qui est considéré comme un
  CanaReel ou non (durée de rétention etc), et peut-être afficher le temps qu'il reste au CanaReel
  avant suppression. A voir."*): an audit of every kind of item the CanaReels tab shows, its
  retention and where that rule lives, then a proposed model and the owner's questions, four at a
  time.

What this reverses: today a live keeps only its newest 20 segments and is deleted at its end - "no
replay", L3 and Q10 in [lives](../services/lives.md#deletion-at-the-end-plus-a-sweep-q10-l3).

What the design owes, measured and not guessed: the bytes per hour from the measured bitrates in
[lives](../services/lives.md) (about 1.4 GB per hour for an Android broadcaster) against one
read-only disk measurement; whether the stored fragments concatenate into one playable file with no
transcoding, on both platforms; how a per-live key meets the reel pipeline's per-file encryption;
the audience, report, staff and broadcaster deletion; a durable-state sweep at three days; the
privacy texts (CGU, privacy page, register C19 "supprimé peu après sa fin"); the work packages,
each migration marked plain or held. A first design run was stopped at the pause of 2026-11-07
before it wrote anything.

**DESIGNED AND DECIDED 2026-11-09: [live-replays](../live-replays.md)** - the measured cost (0.9-1.4
GB per hour of live), the mechanism (the live's own segments kept and served as a `kind = 'replay'`
post, no new file written), the three days as `posts."expiresAt"`, the audience, the CanaReels audit.
**The owner decided the eight questions on 2026-11-09** (the last 3 hours at most, never in backups,
the time left shown, 30 s at least, a 20 GB total cap that evicts the oldest and signals admins, no
repost, a moderation deletion without strike, no "Entre étudiants" for now): the table is
[on the page](../live-replays.md#the-owners-decisions-of-2026-11-09). Two drafts were reconciled into it
(#3234 kept, #3133 closed). WP-R1 and WP-R2 (server) built; WP-R3 (out of the backup) next; the client
(WP-R4, WP-R5) and the texts (WP-R6) owed. The CanaReel rule the owner decided on the way (every
vertical video of 90 s or less, kept one year) is built apart; a replay keeps its own 3 days.
