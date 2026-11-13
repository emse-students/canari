## Reading owed - a reload of a replica list leaves its proxy with a peer: variable targets per service

target: 1.7.0

**What is built:** a reload of a replica list leaves its proxy with a peer: variable targets per service (#2933, first stable `v1.6.3`; [cicd](../cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to))

**The reading that closes it:** across one production deploy carrying it (`v1.6.5` onward qualifies): no `no live upstreams` in the edge's or the frontend's log (`docker logs --since <deploy start>`), read-only
