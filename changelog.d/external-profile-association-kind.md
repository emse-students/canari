### Added - the external profile tells an association, a campaign list and an institution apart

`GET /api/external/profile/:sub` rows now carry `type` and `promo` (and `slug` on former rows), so Sky can group them and hide a past campaign list ([associations](docs/wiki/frontend/modules/associations.md#the-external-profile-projection)).
