### Fixed - the unread pill no longer accuses a row swap of losing its anchor

The anchor is an id and survives a swapped or deleted row; the warning ran before the re-measure it blames and fired on every swap, and now fires only if the id is still gone after it.
