## Live replays - a finished live is kept three days and shown as a CanaReel (owner, 2026-11-07, design not written)

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

**Decided by the owner, 2026-11-09/10 (D1-D8):**

- Storage cap for replays: **20 GB**. When it is reached, the OLDEST replay is deleted early and the
  association's admins are notified.
- A replay is **never republished**.
- A moderation removal of a replay is a plain deletion, **with no strike**.
- **Every vertical video of 90 s or less posted is a CanaReel, and a CanaReel lives 1 year**
  (see [reels](../frontend/modules/reels.md)).
- Old app versions that show raw mention tokens in the live chat: **accepted, no shim**.
