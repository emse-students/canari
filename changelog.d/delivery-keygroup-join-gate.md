### Changed - chat-delivery: a key group's external join is asked of social-service

An external commit into a community's key group, and a Welcome addressed to a key group, are
accepted only for a person social-service entitles to that workspace or channel; when social-service
does not answer, the commit is refused with `503` and retried, never accepted
([channel-encryption](docs/wiki/protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live),
[backlog](docs/wiki/backlog.md#p1---wp-keygroup-join-gate-a-key-group-external-join-is-asked-of-social-service---built-owed-its-503-rate-2026-10-22)).
