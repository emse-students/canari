### Fixed - the first automated production deploy after the move could not bind its port

`v0.18.23` brought the whole estate up except `frontend`: production asked for host port 8080, which
CrowdSec's Local API has held on the shared host since before Canari arrived, and both public
hostnames answered `502` for about fifteen minutes. The manual migration had started the container
on 8081 and taught nginx 8081 without bringing `render-env.sh` along. Production's port is now 8081
everywhere it is declared, the container publishes on the loopback like dev, and the deploy tests
assert every rendered port against a measured list of what this machine has already given away
([estate-migration](docs/wiki/infrastructure/estate-migration.md#the-move-was-finished-by-hand-so-the-first-automated-deploy-took-production-down---2026-09-25)).
