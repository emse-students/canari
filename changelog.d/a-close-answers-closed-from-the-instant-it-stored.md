### Fixed - a close answers "closed" from the instant it stored

The end instant itself now counts as closed on the server and in the app, and the close answer is computed from the same `now` it wrote, so the answer can no longer read "open" in the same millisecond
([forms](docs/wiki/frontend/modules/forms.md#closing-a-form-by-hand-and-the-closing-date-owner-2026-11-16)).
