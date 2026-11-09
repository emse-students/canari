### Changed - the banners are one short line of 32 px

The offline strip says "Hors connexion" and nothing else, the test-environment marker is a 24 px strip, and every banner (maintenance, MLS error, post being sent) shares one height token and one line; the explanatory sentence moved off the screen. See [design-reference](docs/wiki/frontend/design-reference.md#banners-are-one-line-and-one-height-owner-2026-11-09).

The maintenance banner keeps the admin's whole message in its tooltip and in a screen-reader-only copy, and an icon-only `.banner-action` button now has a 44 x 44 hit area.
