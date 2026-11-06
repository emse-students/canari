## P2 - a service-to-service call can still be reset while its peer is retired: the rotation covers only nginx (2026-11-01)

The replica lists take a retiring replica out of the two nginx before it stops
([cicd](../cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)), so a request that goes
through nginx is never reset by a release. A call from one service to another does not go through
nginx: it resolves its peer through Docker's DNS, which names the retiring replica until it stops.
The callers, enumerated in both compose files by the second review of #2866:

- chat-gateway -> chat-delivery-service (`DELIVERY_SERVICE_URL`: the message-send path itself) and
  -> social-service (`SOCIAL_SERVICE_URL`);
- core-service -> social-service (`FORM_URL`, `FORM_SERVICE_URL`);
- social-service -> core-service (`USER_SERVICE_URL`, `PAYMENT_SERVICE_URL`) and
  -> chat-delivery-service (`DELIVERY_INTERNAL_URL`);
- frontend-ssr -> core-service, social-service, chat-delivery-service.

For them, `wait_unqueued`'s two clean reads of the retiring replica's accept queue are a clock, not
a proof: a call can arrive after them and be reset when the listener closes. Not observed; nothing
measures it either - the rig's load goes through the edge only.

**What closes it is a design decision, not built:** the callers reaching their peers through the
frontend nginx (or a second rotated proxy) so the same take-out covers them, or a client-side
retry on a connect refused / reset BEFORE a byte of the request was acknowledged. **The test that
closes it:** a rig case sending POSTs from one fixture service to another across a release of the
second, all answered.

## Design worked out 2026-11-06 (nothing built: it needs a new container on the shared estate)

**The retry option is out, by the rule the rotation was built on.** A client-side retry "before a byte
was acknowledged" cannot be proven to be that: a reset after the request line left can follow a POST
the peer processed, and the cicd page already rejected `proxy_next_upstream non_idempotent` for exactly
that ([cicd](../cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)). The fix removes the reset;
it does not heal it.

**Nothing finer than a proxy can take a replica out of Docker's DNS.** A name resolves to every running
container until it stops, and the one lever that removes an address (`docker network disconnect`)
also cuts the requests in flight (rejected in the same cicd section). So the chosen shape is a proxy
the callers go through, taken out of rotation by the mechanism that exists:

1. **A third rotated proxy, `mesh`, an nginx with no public port**, one `listen` per routed service
   (`3010`, `3012`, `3014`), each `proxy_pass http://$target_<service>` read from
   `infrastructure/edge/targets/mesh.conf`, the SAME variable-target list form as the two existing
   proxies. The services carry `canari.deploy.rotation: mesh:<port>` in addition to the frontend's
   (the label would have to name a list of proxies; `rotation_route` and `rotation_write` take one
   today, which is the code change in `rolling.sh`). It must not be the frontend: that nginx
   strips and rewrites `X-Internal-*` and runs `auth_request`, and a service call carries its own
   `X-Internal-Secret` that the frontend deliberately blanks.
2. **The callers' URLs move to it**, in `docker-compose.prod.yml`, `docker-compose.dev.yml` and
   `local/docker-compose.yml`: the eleven variables above, plus chat-gateway's
   `CORE_SERVICE_URL`/`DELIVERY_SERVICE_URL`, `frontend-ssr`'s three. `mesh` forwards the body and
   headers untouched, with `proxy_http_version 1.1`, no buffering of requests, and the callers'
   keep-alive pools then pin to `mesh`, which re-chooses per request.
3. **A retiring `mesh` is the open point.** `mesh` is itself a container the deploy replaces: during
   its own replacement the callers would resolve it by DNS, the very exposure being closed. It has
   no state and no in-flight work longer than a proxied call, so the replacement order matters more
   than any trick: `mesh` replaced FIRST, while its callers still hold their pools, and it needs its
   own take-out - which no proxy can give it. This needs a decision before building: accept one
   deploy-time exposure on `mesh` alone (a nginx stopping on `SIGQUIT` finishes its connections, so the
   reset window is the accept queue only), or give the callers a second `mesh` replica and a client
   that re-resolves per call. Neither can be judged without the measurement below.

**What can be proven locally and was not done, because the first two steps change the estate's
shape:** the closing test is a case of `deploy-rolling.test.sh` with a fixture service calling a
second one (`rolling-fixture/`) across a release of the second, through `mesh`, hundreds of POSTs
all `200` - the structure of case 2b. Docker is available on a workstation; the missing piece is the
decision in point 3, and the owner's word on a new container on the shared host (a compose service,
no install, but a new process there).

**Measure first** (cheap, and it may show the problem is smaller than the design): the s2s resets per
deploy in the production services' logs (`ECONNRESET` or `socket hang up` to a peer service within a
release window, `docker logs --since`), compared with the count of deploys. Nothing has ever
measured it; zero in the last ten releases would justify leaving this entry as an accepted, named
residue rather than building a proxy.
