### Fixed - a reply queued from the notification shade is no longer erased by the open app

A reply sent from the shade while the app was warm in the background, or one the background sender had given up on, was erased by the app's next outbox change: never sent, never shown failed. The app now writes only its own lines of the shared queue, under the lock the native side takes, and takes the shade's lines into its outbox whenever it returns to the front ([chat-delivery](docs/wiki/services/chat-delivery.md#the-outbox-mirror-has-two-writers)).
