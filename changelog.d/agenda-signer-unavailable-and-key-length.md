### Fixed - a 503 or an offline agenda link no longer reads as a campus refusal, and a short signing key fails the deploy

The subscribe modal now says "unavailable, try later" for a 5xx or network failure, and `render-env.sh` refuses an `AGENDA_SIGNING_KEY` under 32 characters. See [profiles-and-access](docs/wiki/profiles-and-access.md#d40-amended---the-selection-is-signed-and-only-the-readers-own-spaces-are-signed-2026-10-06).
