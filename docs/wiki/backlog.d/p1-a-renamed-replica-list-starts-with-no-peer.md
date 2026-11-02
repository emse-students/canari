## P1 - every take-out and restore of a replica list leaves the reloaded nginx with NO replica until its resolver answers (measured 2026-11-02)

**What it is.** `rolling.sh` writes every `upstream` server with `resolve` (`server core-service:3012
resolve;` at rest, `server canari-core-service-2:3012 resolve;` during a take-out). nginx never
resolves a `resolve` server when it loads the configuration: the new worker starts with that server's
peer list EMPTY and fills it when its own asynchronous DNS query returns. Across a reload the zone
carries the addresses over only for a server whose NAME it already resolved
(`ngx_stream_upstream_zone_preresolve` and its http twin match the old peers by host name). The
take-out renames the service's server (service -> container) and the restore renames it back
(container -> service), so after each of those reloads the new worker has no peer for a moment, and a
request it takes then is refused on the spot: `no live upstreams while connecting to upstream` - a
closed connection at the edge (the client's `ECONNRESET`), a `502` at the frontend. Two such reloads
per replaced service, at both proxies, in every production deploy.

**Evidence.**

- CI: main-era run 41368923993 (PR #2564, a gradle-wrapper bump), `deploy-rolling: v2 -> v3`:
  `transport:ECONNRESET x1 (of 401)`. 1 run in the 58 that ran the self-tests since #2866 merged
  (2026-11-01 22:14 to 2026-11-02 07:30); the other 57 answered every POST.
- Reproduced in isolation (Docker 29.7.2, production's edge image `nginx:1.31.8-alpine`, the edge's
  own `stream` block with `zone`/`resolver valid=2s`/`resolve`, a bun client sending
  `connection: close` POSTs at concurrency 12):
  - 300 edge reloads, the server name ALTERNATING between two names of the same container:
    **252 `ECONNRESET` in 103 895**, every one logged by the edge as `no live upstreams`;
  - 300 reloads with the name UNCHANGED: 0 in 68 920 (this is the case the old note "`resolve` costs
    no window at a reload" measured - it is true only while the name stays);
  - 300 reloads of a static `server` with no `resolve`: 0 in 100 303; 300 reloads of the frontend's
    nginx (http) with no upstream at all: 0 in 203 589 - a reload by itself drops nothing.
- Ruled out as the cause: the drain (the pairing check, `wait_unqueued`, `SIGQUIT`), the client's
  keep-alive (it opens one connection per request), Docker's port proxy - the reproduction has none of
  them and fails at the same rate per reload.

**Why the obvious fixes are not fixes.**

- A `server` WITHOUT `resolve` for the container during a take-out is resolved by the master when it
  loads the file, so the take-out has no window - but the restore still renames the service's server
  back to a `resolve` one, with the same window.
- Keeping the service's name in the take-out list as `server <service>:<port> resolve down;` so its
  addresses carry over to the restore: they carry over STALE. The name was last resolved while the old
  replica still ran (up to `valid=2s` before), so the restored worker starts with the stopped
  replica's address, and a connection to a removed container's address on a Docker bridge is not
  refused - it times out (measured: no answer within 10 s), so every request choosing it stalls
  `proxy_connect_timeout` (2 s) before nginx hands it on. A failure turned into a stall, healed by a
  clock.
- A `backup` line naming the new replica by address during the restore is a fallback path (refused
  by the standing rules), and it must be removed by a later reload whose safety depends on the
  resolver having answered - the same unprovable wait.
- Waiting `ROLLING_RESOLVER_TTL_SECONDS` before the restore is a clock.

**The fix, measured and not built: no `upstream { ... resolve }` at all.** The list defines, per routed
service, the TARGET of a variable `proxy_pass` instead of an `upstream` block:

- at rest, the service's DNS name with its port (`core-service:3012`): nginx resolves a variable target
  per request through `resolver 127.0.0.11 valid=2s`, and the REQUEST WAITS for the answer - a fresh
  worker has no empty list to refuse from. This is what the frontend did before the lists, so a
  rollback to a library older than them (which waits 3 s for nginx to re-resolve) is served as today;
- during a take-out, the new replica's ADDRESS (`<its address>:3012`, read by `docker inspect` on the
  network the proxy shares with it): nothing to resolve, chosen from the reload's first instant.

Measured on the same rig: 300 edge reloads alternating `map "" $frontend_target` between
`fea:80` and an address literal, the edge doing `proxy_pass $frontend_target;`: **0 failures in
257 914 POSTs**. A variable target caches no upstream connection, so the pairing check's `keepalive 0`
requirement disappears with the blocks.

What it touches, which is why it is a design decision and not a patch: the list format
(`rotation_block`, `rotation_write`, the render token, `lists_at_rest`), every `set $upstream_x
<service>; proxy_pass http://$upstream_x;` site of `Dockerfile.frontend` routed through a list (about
twenty), its baked list and `deploy-replace.test.sh`'s byte-for-byte comparison of it,
`rotation_subrequest_ports` (it reads the `set` targets), the edge's `proxy_pass frontend;`, and the
fixture's two frontend configurations.

**The test that closes it:** a `deploy-rolling.test.sh` case that reloads each proxy on the take-out
list and back on the resting one, a few hundred times, under the client's load, and asserts every
POST is answered `200` - on today's lists it fails within a few dozen reloads, so it does not depend
on the 1-in-58 luck of a whole release. Mechanism: [cicd](../cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to).
