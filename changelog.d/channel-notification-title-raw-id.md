### Fixed - a channel notification titled itself with its own raw conversation id

`notificationGroupName` preferred `contactName`, which every channel row builder deliberately keeps
as the raw `channel_<uuid>` id (the key seed routing reads), over `name`, which carries the real one
([nativeNotification.ts](frontend/src/lib/utils/nativeNotification.ts)).
