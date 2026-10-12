### Fixed - salons no longer stop opening until a restart after a conversation restore

A restore that ran after the community load erased the salon rows it did not hold, so tapping those salons lit the row and opened nothing; it now keeps them, and a dropped selection is logged ([chat](docs/wiki/frontend/modules/chat.md#the-restore-keeps-the-salon-rows-the-community-load-wrote-2026-10-12)).
