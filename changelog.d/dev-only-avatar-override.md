### Added - the dev estate can serve an explicit avatar per account, and cannot be made to on production

`DEV_AVATAR_OVERRIDE_DIR` swaps the gallery's avatar for an invented geometric portrait on listed accounts; core-service refuses to boot with it set on any estate whose `FRONTEND_URL` is not dev's ([dev-environment](docs/wiki/infrastructure/dev-environment.md#explicit-dev-avatars-the-only-face-dev-has-2026-11-09)).
