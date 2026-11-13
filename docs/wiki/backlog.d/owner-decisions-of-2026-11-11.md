## The owner's decisions of 2026-11-11

target: 1.7.0

- **`1.6.10` shipped to production on 2026-11-11** ([roadmap](../roadmap.md)).
- **Fewer features, the backlog first.** *"On va se calmer un peu sur les features pour la suite. Il
  faut réduire et traiter le backlog, et corriger des bugs de longue date."*
  - **The slow-link chantier stays FIRST**: it is a fix, not a feature
    ([chantier](slow-link-local-first-chantier.md)).
  - **Then the backlog, OLDEST entries first.**
  - **An entry blocked only on a phone reading**: the lead takes the reading himself on the bench
    Mi 9T / iPhone 12, closes what passes, and reopens as a bug what fails.
  - **An entry that became moot**: the lead closes it on his own, with the evidence written down
    where it is closed.
  - **No new feature unless the owner asks for it.**
- **Earlier the same day** (shipped in `1.6.10`, #3329):
  - in-app suggestions are ON by default, their push OFF by default (*"Deux niveaux"*);
  - the "Wi-Fi seulement" autoplay choice is hidden where the device cannot tell Wi-Fi from mobile
    data.

### The afternoon of 2026-11-11

1. **A member's vanished conversation marker is not a misrouting bug.** The owner confirmed the
   member opened the conversation and reacted around 08:01 themselves: the marker disappeared
   legitimately. The only defect was its loss on restart (#3330).
2. **`1.6.11`**: the lead cuts the alpha, reads it on the Mi 9T and the iPhone 12, and cuts the
   stable if nothing blocks; the owner is told each time.
3. **Guided help**: first re-read on both phones the helps already shipped (batches 1, 3 and 4, and
   the profile-photo card) and fix what fails. Then build two new hints, as drafts for `1.6.12`: PIN
   and encryption (why a PIN exists, what to do when it is forgotten), and communities (salons and
   channels).
4. **Slow link**: media already seen is kept on the device within a **200 MB** budget, the oldest
   evicted first (gap 3 of the [chantier](slow-link-local-first-chantier.md)).
5. **The profile-photo prompt stays limited to ICM at Saint-Etienne, and it is no longer temporary**:
   *"MiGallery est faite avant tout pour les ICM/Saint-Etienne"*. The server gate
   (`PROFILE_PHOTO_PROMPT_SPACES`) stays ([guided-help](../frontend/guided-help.md#the-profile-photo-prompt-owner-2026-11-07)).
6. **Production data cleanups that close a backlog entry** (orphan devices and the like): the lead
   may run them alone (*"Oui pour tout"*), under his own safeguards - a procedure written in the
   wiki, tried on dev first, the deleted rows saved, and the cleanup recorded in a `changelog.d`
   fragment.
7. **The slow-link work stays DISCREET AND INFORMATIVE, never verbose or useless** (corrected by the
   owner the same day: *"Il n'y a pas de règle 'tout doit être invisible', c'est juste que là c'est
   verbeux et inutile. Quelque chose de discret et informatif est super."*). There is NO rule that
   everything must be invisible: the "Lire quand même" button and the percentage label once planned
   for the video hold were rejected as verbose and useless (#3333 removed both), not because any
   indicator is forbidden. **The connection indicator the owner wants is the header avatar's ring**:
   green connected, amber slow, grey offline - replacing the "Hors connexion" banner and the desktop
   "connecté" pill. Built in a separate draft PR ([chantier](slow-link-local-first-chantier.md)).
8. **Feed media smoothness**: before a media is ready, the page draws the best picture it knows -
   the decoded first frame, else the ThumbHash, photos included - never black. The next 3 pages are
   preloaded in parallel on a fast link and 1 on a slow link, heads only, and the stream joins the
   preloaded bytes. This REPLACES the decision of 2026-11-04 that the preload stays behind the
   settled reel. Built by a separate PR.
9. **A video tapped in the feed opens the viewer in the reader's REMEMBERED order**, with the
   Pour toi / Recents switch shown. Built by another PR.
