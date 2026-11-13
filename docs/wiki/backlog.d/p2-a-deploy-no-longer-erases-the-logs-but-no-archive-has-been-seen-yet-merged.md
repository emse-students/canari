## Reading owed - one rotated log archive per container on both estates

target: 1.7.0

**Owed now (both estates deployed `v1.4.0` since):** one `.log.gz` per container in `~/deploy-log-archive/<project>/` and `max-size` on a recreated container ([logging](../infrastructure/logging.md)). Authentik's hand-run stack is bounded only when next recreated and is not archived; **no container is recreated unattended for it (owner, 2026-10-24)** ([logging](../infrastructure/logging.md#no-unattended-container-recreation-for-log-retention-owner-2026-10-24)).
