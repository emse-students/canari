### Fixed - the Back arrow after opening an association, profile or event from another section returns to that section

From a post, tapping its association then the arrow used to land on the Associations list, because the arrow was always a link to the structural parent. Every entry now remembers the page it was reached from, and the arrow walks history when that page is the parent or another top-level section ([section-navigation](docs/wiki/frontend/section-navigation.md#back-after-a-cross-section-open-returns-to-the-origin-owner-report-2026-11-15)).
