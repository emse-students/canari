### Fixed - a salon ending on membership notices kept a ghost unread badge

The read mark skipped system rows, so "X added Y" notices at the end of a salon were counted by the server for ever and the badge returned at every reload ([chat](docs/wiki/frontend/modules/chat.md#a-salon-read-mark-reaches-its-membership-notices-2026-10-11)).
