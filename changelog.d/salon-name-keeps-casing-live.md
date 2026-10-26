### Fixed - a salon created while members are online keeps its casing

`onChannelMemberJoined` no longer lower-cases the salon name: `BIG3-xyz-salon` shows as the server sent it,
not `big3-xyz-salon`, until a reload. See `ChatBackgroundService.svelte`.
