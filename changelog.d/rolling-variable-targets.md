### Fixed - a deploy's reload no longer leaves a proxy with no replica: the replica lists are variable targets

Every take-out and restore renamed a `resolve` server in an `upstream` list, and nginx started the reloaded worker with no peer until its DNS query returned, refusing what it took meanwhile (`no live upstreams`, the self-test's lone reset). Each proxy now reads `$target_<service>`: the DNS name at rest, resolved for the request, and the new replica's address during a take-out. See [cicd](docs/wiki/cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to).
