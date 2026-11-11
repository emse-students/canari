## P2 - media-service and call-service still have a gap on each release (seen 2026-10-09, re-read 2026-11-11)

Every other service is started beside its old replica and drained ([cicd](../cicd.md#a-deploy-replaces-nothing-a-member-is-talking-to)); these two are still `canari.deploy.replace: exclusive` in both compose files, recreated in place, so an upload or a call started in those few seconds fails. The deploy's resolver report names the gap (`gap - media-service x2 "Host not found": an exclusive service`, `infrastructure/lib/resolver-report.sh`).

- **media-service** keeps its metadata index as one JSON file, `media_meta/media_metadata.json`, which two replicas would both write ([media-service](../services/media-service.md)). Closing it means moving the index into Postgres.
- **call-service** keeps its rooms in memory. Closing it means either accepting that a release ends a call, written down as the contract, or handing rooms over from the old replica to the new one.

Production 1:1 calls go peer to peer through TURN ([calls](../frontend/modules/calls.md)), so what a release cuts is the signalling seat; the call's own resume path is what would carry it.
