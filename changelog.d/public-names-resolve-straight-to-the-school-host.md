### Changed - the public names no longer cross a home tunnel

`canari-emse.fr`, `dev.`, `auth.` and `cercle.` now resolve as Cloudflare-proxied records straight to the school host, with SSL mode Full ending at its own certificate; the home tunnel keeps only unrelated routes. See [cloudflare-edge](docs/wiki/infrastructure/cloudflare-edge.md#topology).
