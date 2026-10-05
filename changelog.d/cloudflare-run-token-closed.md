### Security - the tunnel run token no longer appears on any command line

On all three tunnel hosts the token moved into a root-only environment file and was rotated; an unprivileged user can no longer read it with `systemctl show` ([cloudflare-edge](docs/wiki/infrastructure/cloudflare-edge.md)).
