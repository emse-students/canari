### Changed - the last live mentions of the old apex

The egress probe now measures `canari.emse.fr` and keeps `canari-emse.fr` as a SECOND probe rather
than a replacement: the two arrive by different paths - one straight to the shared host, the other
through the old box's relay and the Cloudflare tunnel - so they can fail independently and which
one failed is the diagnosis. The Cercle runbook and the Tauri navigation fixture follow
([estate-migration](docs/wiki/infrastructure/estate-migration.md#7-phase-2---the-names)).
