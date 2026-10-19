### Fixed - a resumed call gets its audio back, and the partner of a phone that never returns is told

On the `1.3.1-alpha.2` bench a 14 s Wi-Fi outage resumed but left both phones silent on "Reconnexion...", and after 90 s the partner never ended. The relay now holds a socket dead when it stops answering keepalive pings, the restart is an explicit offer that rolls back one lost in a dead socket, and the resume ladder is capped at 4 s ([calls](docs/wiki/frontend/modules/calls.md#what-the-131-alpha2-bench-reading-found-2026-10-19-and-the-fix)).
