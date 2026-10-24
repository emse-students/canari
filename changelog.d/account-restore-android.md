### Added - account restore on a new Android phone (WP-RESTORE-1)

A session registers a restore key that Android keeps in the Google backup; a new phone restored from it reopens that session with no sign-in, and the old phone is signed out, its push registration ended with its session. Required by Google Play from April 2027 ([account-restore](docs/wiki/account-restore.md)).
