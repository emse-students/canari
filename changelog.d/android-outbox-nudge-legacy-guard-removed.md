### Changed - Android: the pre-1.7.3 outbox nudge guard is gone, because an update already clears it

Android cancels every notification of a package when it is updated, so no nudge posted under the
worker's id before 1.7.3 can survive into it; the guard that cancelled one, and the minSdk-28 dead
`SDK_INT >= 26` branches of the push service, are deleted ([mobile](docs/wiki/frontend/mobile.md#the-outbox-nudge)).
