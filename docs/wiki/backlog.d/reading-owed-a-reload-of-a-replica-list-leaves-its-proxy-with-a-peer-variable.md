## Reading owed - a reload of a replica list leaves its proxy with a peer: variable targets per service

target: 1.7.0

**What is built:** a reload of a replica list leaves its proxy with a peer: variable targets per service (#2933, first stable `v1.6.3`; [cicd](../cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to))

**The reading that closes it:** across one production deploy carrying it (`v1.6.5` onward qualifies): no `no live upstreams` in the edge's or the frontend's log (`docker logs --since <deploy start>`), read-only

**Not readable after the fact (checked 2026-11-14).** The `v1.6.11` deploy recreated the
frontend AND the edge, so the proxies that reloaded their lists during it are gone, and their
logs were archived BEFORE the deploy's first `up -d` - nothing kept holds the deploy window; the
live frontend log had also rotated past it (10 MB x 3 keeps about 12 hours). On dev, the edge that stayed up
across five deploys (2026-11-12 to 2026-11-13) logged 0 `no live upstreams`. **The production
reading has to be taken DURING a deploy**: `docker logs -f` of the frontend and the edge from the
deploy's start until each is replaced, at the next stable.
