### Fixed - a post notification tapped with the session already dead no longer lands on a bare sign-in page

The session-expired handler went to `/login` while the deep link's navigation was still in flight, so the target was dropped; it now carries the page being navigated to as `returnTo` ([sessions](docs/wiki/sessions.md#a-dead-session-sends-the-user-to-login-carrying-where-they-were-going-2026-10-09)). Owed one reading on the Mi 9T.
