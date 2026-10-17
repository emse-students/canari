### Fixed - the token refresh and the sign-out no longer wait for ever on a stalled link

Both now have a response deadline, and an expiry is a transport failure that never logs anyone out; a refresh that misses it is re-sent once with the same credential, inside the server's rotation grace ([sessions](docs/wiki/sessions.md#every-first-party-request-has-a-deadline-the-refresh-and-the-sign-out-included-2026-10-16)).
