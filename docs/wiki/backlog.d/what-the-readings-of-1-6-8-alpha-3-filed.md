## P3 - three observations of the `v1.6.8-alpha.3` readings, to be looked at (2026-11-08)

Read on dev. The title of an association tab and the iOS donations were filed as defects and fixed
apart; these three are left, none blocks the stable.

1. **A follower tab reads "Hors-ligne" while it is online, and the open conversation is deselected
   on a leadership change.** Repro: open the web app in two tabs of one browser profile; the second
   becomes a follower and delegates its commits to the leader tab. The follower's header shows
   "Hors-ligne" although the network is up. Then close or freeze the leader: the remaining tab takes
   over leadership and the conversation it had open is deselected. Look at what the header reads
   (it should be reachability, not "I am not the writer") and at whether the takeover resets the
   selected conversation.
2. **The paid-forms warning banner in the form editor wraps badly on a phone.** Repro: open a form
   with a paid field in the editor at phone width; the link inside the banner is oddly indented and
   a lone "." sits dangling on its own line. A layout of the banner's inline link and its trailing
   punctuation (the full stop belongs to the sentence, the link should not be a block).
3. **After "Terminer" on a live on the iPhone, the live screen seemed to stay up, and about five
   minutes later an alert read "Live terminé - Le live s'est arrêté pendant que la caméra était en
   pause".** Low certainty: it was seen once. Repro to try: start a live on the iPhone, tap
   "Terminer", watch whether the live screen closes at once, and keep the app open for ten minutes.
   If it reproduces, the stop path leaves the camera session or the watchdog alive after the end
   ([live](../frontend/modules/live.md));
   until then it needs a reproduction, not a fix.
