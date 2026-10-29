### Fixed - a live viewer no longer stalls on a paired producer, nor loses the end of a live

The viewer bounds its wait from the shape of the deliveries and re-anchors a short buffer at once
([buffer policy](docs/wiki/frontend/modules/live.md#the-buffer-policy-l-f1-2026-10-27)); an
ordinary end's purge waits for the seated viewers
([lives](docs/wiki/services/lives.md#deletion-at-the-end-plus-a-sweep-q10-l3)).
