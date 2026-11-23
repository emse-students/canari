## Reading owed - a DM thread left above its end after a resume from iOS Settings (2026-11-23)

target: 1.8.0

Seen once on the iPhone 12 on `1.8.0-alpha.2` and not chased: after the app resumed from the iOS
Settings app with a DM open, the thread was NOT at its end (the last photo sat behind the composer).
It was a resume position, not the keyboard path of #3984, which passed 3 of 3 the same day
([readings](../device-verification.md#the-readings-of-2026-11-23-180-alpha2-the-resume-with-salons-the-share-shortcuts-the-keyboard-on-a-photo-dm-the-inactive-iphone)).

**Steps to reproduce.** On the iPhone 12, open a DM whose last messages are photos and wait for them
to load (the thread is at its end). Open iOS Settings (the app goes to the background), then return
to Canari. Look at the thread and whether the "Scroll to bottom" arrow shows.

**What to read.** Export the in-app log at once and look for `left the bottom with no finger on the
pane` (the pane's own put-back line) and for the resume's `[CHAT_VIEW]` line; the cause is the
resume's placement of the pane, or the thread's measure after the return, and nothing says which.
Repeat five times, with and without a keyboard up before leaving. A thread that is at its end every
time closes the entry; one that is not names the cause to fix.

**2026-11-23, `1.8.0-alpha.3` ([iPhone 12 sitting](../device-verification.md#the-readings-of-2026-11-23-180-alpha3-iphone-12-the-resume-from-settings-the-pushes-name-and-logo-the-banners-the-share-logos-the-ios-27-launch)): FAIL once in 13 resumes, entry kept.** Five resumes from Settings (three without a keyboard, two with it up) and a 25 s stay left the thread at its end every time, the keyboard ones logging the pane's put-back line. Then a HOME-BUTTON leave with the keyboard up and a return a few seconds later left the thread above its end, the "Scroll to bottom" arrow showing, and NO `left the bottom with no finger on the pane` line at that resume (the lifecycle lines were there); the state outlived a relaunch until a tap. Six more keyboard-up home-button cycles did not reproduce it. So the resume has a path on which the pane's put-back does not fire; the next step is to log the pane's geometry at the foreground edge (scrollTop, scrollHeight, the keyboard inset) so the next occurrence names the cause, then fix it. Not a regression of #3984 (the keyboard path passed again).
