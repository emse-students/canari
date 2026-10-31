### Fixed - a message sent while this device is being re-admitted to a group is held, not lost

A send in the seconds between the Remove and the Welcome of the device's own re-admission was failed as an eviction, which retired the conversation; it is now held and sent the moment the Welcome or an external join makes the group ready, without waiting for the retry timer ([chat](docs/wiki/frontend/modules/chat.md#a-group-becoming-ready-resumes-what-was-held-for-it-and-a-re-admission-holds-2026-10-31)).
