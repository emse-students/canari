### Fixed - Android: the "messages en attente" nudge leaves the shade once its reply is delivered

Every native drain withdraws the nudge when the outbox mirror is empty, and the nudge has its own
notification id instead of sharing the background worker's. The launcher badge no longer counts the
new-device and worker-failure notices as unread conversations ([mobile](docs/wiki/frontend/mobile.md#the-outbox-nudge)).
