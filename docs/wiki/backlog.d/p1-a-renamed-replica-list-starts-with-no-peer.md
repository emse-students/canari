## P1 - a renamed replica list started its proxy with no peer: fixed by variable targets, owed its release

**Built 2026-11-02, not yet shipped.** Every take-out and restore reload renamed a `resolve` server
in an `upstream` list, and the reloaded nginx had NO peer until its own DNS query returned: what it
took meanwhile was refused (`no live upstreams` - an `ECONNRESET` at the edge, a `502` at the
frontend; the one reset of main-era run 41368923993). Each proxy now reads a variable target per
service (`$target_<service>`): the DNS name at rest and the new replica's container name during a
take-out, each resolved for the request (`resolver_timeout 2s`, its failures counted daily by
`scheduled.yml`'s `resolver` job). The mechanism, the measurements, the four rejected fixes and the
closing test (`deploy-rolling.test.sh` case 2b, hundreds of reloads under load) are in
[cicd](../cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to).

**Owed:** the release that carries it - then delete this file and `CLAUDE.md` queue item 31 - and one
reading on the first production deploy carrying it: no `no live upstreams` in the edge's or the
frontend's log across that deploy (`docker logs --since <deploy start>`).
