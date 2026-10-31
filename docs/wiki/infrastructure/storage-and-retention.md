# Storage and retention - audit of 2026-10-11 (summary)

The read-only measurement of the production host (disk, volumes, logs, backups, cron) is kept in the
operators' private notes: it maps a shared host. The model and history are in
[storage-forecast](storage-forecast.md), the backup scheme in [backup](backup.md), the image prune in
[docker-prune](../../../infrastructure/docker-prune/README.md).

## 1. The host disk

Disk pressure on the shared host is real. Reclaimable space is mostly dangling images from the
eight Canari services, about two gigabytes per deploy generation; nothing is installed on that host
to reclaim it without the DSI's written agreement ([durable-rules](../durable-rules.md)).

### Logs

Canari containers are capped by size (`json-file`, `max-size 10m`, `max-file 3`), a SIZE bound and
not an age one; the privacy policy's 90 days are reported daily for live logs and enforced on the
deploy-log archive since 2026-10-16 ([logging](logging.md#the-90-day-ceiling-2026-10-16)). Host-level
logs and co-tenant containers are the host owner's to bound
([dsi-log-retention-request](dsi-log-retention-request.md)).

### Why the nightly dump grew

Measured 2026-10-24: one table, `queued_message`, and in it one community key group's queue
([backup](backup.md#why-the-archive-went-from-80-mb-to-700-mb-2026-10-13)).

## 2. What is still UNMEASURED

The media index by retention class, the
real size of the container runtime's directory, and the automatic-cleanup inventory with the last run
of each.
