### Fixed - the upstream monitor reported three names "down" for three days while they were up

Cloudflare challenged every reading from GitHub's runners (`403`, `cf-mitigated: challenge`); the monitor now reports that as its own blindness, never as an outage, and a push to `main` reports a monitor that stopped reading ([upstream-reachability](docs/wiki/infrastructure/upstream-reachability.md#when-the-monitor-is-refused)).
