### Changed - the four media-service audit ignores retire themselves, and the 22h band is re-measured

CI now fails the day an ignored advisory is no longer reported, instead of a dated hand re-check of minio ([cicd](docs/wiki/cicd.md#four-audit-advisories-are-suppressed-on-one-edge-of-media-service-and-why-each-is-unreachable)). The tunnel's 22h drop did not recur in seven days ([cloudflare-edge](docs/wiki/infrastructure/cloudflare-edge.md#the-tunnel-drops-in-the-22h-band-and-nothing-on-this-page-can-fix-it)), and every backlog item whose only action was a request to the School is deleted.
