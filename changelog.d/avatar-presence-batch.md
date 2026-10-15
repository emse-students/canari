### Fixed - a member without a photo is no longer asked for one

Which faces exist is asked once per list (`GET /api/users/avatar-presence`, answered by MiGallery), so a salon open no longer collects one `404` per member without a photo - 37 in one Mi 9T walk ([core-service](docs/wiki/services/core-service.md#which-faces-exist-asked-once-per-list-2026-10-14)).
