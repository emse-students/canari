### Fixed - an iPhone's notification extension no longer presents a push secret the server already refused

The extension's copy of the secret followed the app's lifecycle while `/register` rotated it right after, so six iPhones got no avatar and no commit catch-up in their notifications; it is now written when the secret is stored, and login no longer registers twice ([mobile](docs/wiki/frontend/mobile.md#the-extensions-copy-that-followed-the-lifecycle-and-the-iphones-that-presented-a-dead-secret)).
