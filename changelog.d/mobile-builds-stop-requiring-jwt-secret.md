### Changed - the mobile builds stop requiring the server's JWT signing secret

The Android and iOS release builds checked that `JWT_SECRET` was set, but neither app is built with
it. The check is gone, so the secret is read only by the production deploy, which lets it move into
that environment when the repository's secrets are tidied
([backlog](docs/wiki/backlog.d/p2-the-repository-holds-github-s-maximum-of-100-secrets.md)).
