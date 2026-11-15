### Fixed - a push tapped after the session ended signs in to the page it named

A dead-session verdict reached before its handler is queued with its target instead of a bare redirect to `/login`, and a login page already mounted follows a new `?returnTo=` (Mi 9T: 2 of 4 taps went to the wrong page). See [sessions](docs/wiki/sessions.md#a-dead-session-sends-the-user-to-login-carrying-where-they-were-going-2026-10-09).
