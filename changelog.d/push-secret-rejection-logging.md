### Fixed - a PushSecret rejection on a background push endpoint left no server-side trace

`verifyPushSecretAuth` threw `ForbiddenException` with no log line, so a 403 on
`/api/mls/push/*` was diagnosable only from the nginx access log, never from our own service.
Found while root-causing a CrowdSec ban that closed `sky.mitv.fr` for an unrelated EMSE visitor
([infrastructure](docs/wiki/infrastructure/estate-migration.md#crowdsec-covers-this-host-in-two-halves-and-only-one-of-them-reaches-every-vhost)).
