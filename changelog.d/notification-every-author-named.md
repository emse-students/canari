### Changed - an Android message notification names every author, and a contact with no photo is no longer re-asked for one on every notification

A direct message now looks like a group: the person's name above their lines, "Vous"/"You" above ours. A `404` from the avatar proxy is remembered for 24 h, while a `502`/`503` or a network failure is never remembered ([mobile](docs/wiki/frontend/mobile.md#the-face-on-a-notification-and-what-happens-when-there-is-none)).
