### Fixed - a voice note shown as "Format non supporte" logs why

The audio element's refusal now logs its media error code, the declared type and the engine's `canPlayType` answer, so the Mi 9T report can be read ([chat](docs/wiki/frontend/modules/chat.md#format-non-supporte-names-its-cause-in-the-log-2026-10-18)).
