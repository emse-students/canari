## P3 - MiConnect's unused Docker service connection fails its monitor every few minutes (owner decided 2026-10-31: delete it; one click owed)

Authentik keeps a "Local Docker connection" object although the Docker socket was removed from the
worker on 2026-09-24 ([authentik compose](../../../infrastructure/authentik/compose.yml), the comment on
the worker's volumes). Its periodic monitor task fails each time with `DockerException` (no such
socket) - about one failure line every two minutes in the worker log, the only error line it writes.
**Nothing references it**: the only outpost is the embedded one, which has no service connection,
and no Kubernetes connection exists (read 2026-10-31). The owner decided to delete it.

**Owed: one deletion in the admin UI** (System > Outpost integrations), by an administrator - an agent
could not reach the admin API without minting a credential. Afterwards, the worker log must show no
new `service_connection` / `DockerException` line, and the connection must not come back at the next
worker start (Authentik recreates a local Docker connection only when it finds the socket).
