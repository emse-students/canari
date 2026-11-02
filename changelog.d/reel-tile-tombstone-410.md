### Added - a conversation reel whose file is gone reads "CanaReel supprimé" (RC-6)

The reel viewer's `410` is recorded on the message's local row, so the tile draws "CanaReel supprimé" (before the sender's expiry hint) or "expiré" (after) across reloads, and the cached copy is dropped ([reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md#18-what-the-tile-and-viewer-package-rc-6-built-2026-11-02)).
