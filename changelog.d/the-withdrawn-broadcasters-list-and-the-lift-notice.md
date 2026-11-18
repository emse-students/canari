### Fixed - a withdrawn right to broadcast can be given back from a list, and the member is told

The right to broadcast, once withdrawn, was restorable only from a pending live report. Staff now have a
"Diffusion retirée" tab in `/admin/moderation` listing the withdrawn accounts with the lift, the live
moderation toasts read as successes, and the member gets a "restored" notice and push
([live](docs/wiki/frontend/modules/live.md#the-moderation-client-wp-l8s-client-half-2026-10-19)).
