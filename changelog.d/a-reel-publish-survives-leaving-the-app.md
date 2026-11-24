### Fixed - a CanaReel publish no longer dies when the phone stops the app

"Publier" on the CanaReels camera now hands the take to the background publish queue: it is kept on
the device, sent in resumable parts, created once under its own id, and shown in the banner while it
waits or fails. The screen stays on while a post is being sent, since a screen going to sleep stopped
the app and, under battery saver, cut its network mid-upload ([reels](docs/wiki/frontend/modules/reels.md#publishing-r3-on-c2-and-c3)).
