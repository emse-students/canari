## Reading owed - one phone cold start of the MLS init behind the avatars

target: 1.7.0

The avatars are edge-cached and batching them is REFUTED
([core-service](../services/core-service.md#the-avatar-proxy)); the browser re-reading on `v0.18.16`
puts MLS ready at 968-1182 ms, so the window did not reproduce
([cold-start](../frontend/cold-start.md#the-split-answered-on-the-day-it-shipped-an-ordinary-boot-is-968-ms-and-mls-load-state-is-8-of-it-2026-09-20)).
**Owed**: one cold start on a phone, whose console lines bracket themselves (`+<ms>` since #742) -
write no marks. **Do not "fix" it by lowering the avatars' fetch priority** (advisory, per-engine,
would make the measurement unreproducible).
