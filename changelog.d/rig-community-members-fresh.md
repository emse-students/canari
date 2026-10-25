### Fixed - the salon rows read the community roster fresh

`openCommunityMembers` reused a members tab that was already open. That tab loaded its roster when it opened and never reloaded it, so RM-4..6 looked for a member who had joined since and found no row. It now leaves the tab and comes back, which is the app's own reload ([cross-client-testing](docs/wiki/cross-client-testing.md)).
