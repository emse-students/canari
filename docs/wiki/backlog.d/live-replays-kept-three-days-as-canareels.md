## Live replays - a finished live is kept three days and shown as a CanaReel (owner, 2026-11-07; designed 2026-11-09, not built)

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

**DESIGNED 2026-11-09: [live-replays](../live-replays.md)** - the measured cost (0.9-1.4 GB per
hour of live; production stores 0.9), the mechanism (the live's own segments kept and served as a
replay post, no new file written), the three days as `posts."expiresAt"` read by the existing
sweeps, the audience, the CanaReels audit and its proposed model, the migrations (none held), the
work packages WP-R1..WP-R6, the readings, and eight questions for the owner in two lots. The finding
that decides the shape: replays in the nightly media backup would cost about 47 days' worth of
replay on the same disk, so the design takes the segments out of the backup (WP-R3).
