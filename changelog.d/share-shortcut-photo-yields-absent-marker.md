### Fixed - a contact's profile photo reaches the launcher shortcuts even after a "no photo" was remembered

A 404 learned before the photo was uploaded kept the initials disc for 24 hours. A user the app knows
to have a photo (`avatar-presence`) now makes the native side drop that remembered absence, so the
next shortcut publish fetches the picture
([sharing](docs/wiki/frontend/sharing.md#the-picture-of-a-shortcut-absence-yields-to-presence)).
