### Security - avatar URLs carry a viewer-bound token, phase 1

Core mints an avatar token beside every access token, bound to the session; every client avatar URL
is built by one helper that carries it, and core refuses a wrong one with a bodyless 403. A request
with no token is still answered and logged `access=unsigned` until phase 2 refuses it; the edge
never forwards the internal credential, and the access log drops the avatar query
([sessions](docs/wiki/sessions.md#the-avatar-token)).
