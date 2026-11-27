### Fixed - a campus trend push names its post again, so a post already displayed on the device stays silent and the banner opens the post

The trend push dropped its `postId` (passed beside the fields `pushNotice` reads, never in its push data), so neither phone could recognise a post it had displayed and the banner opened the feed; each end of the device's decision is now logged, a trend naming no post as a warning ([engagement](docs/wiki/engagement.md#a-campus-trend-for-a-post-this-device-already-displayed-shows-nothing-2026-11-24)).
