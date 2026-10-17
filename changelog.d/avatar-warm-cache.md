### Changed - a profile picture no longer flashes its initials when a chat or list remounts

Decoded avatars stay in memory for three minutes after their last use (300 faces at most), so a remount draws the photo on the first frame with no request ([core-service](docs/wiki/services/core-service.md#the-warm-window-a-remount-costs-nothing-for-three-minutes-2026-10-16)).
