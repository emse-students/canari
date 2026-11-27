### Fixed - the image scan: libxml2 2.13.9-r5 in the two Alpine images we build, PAM deb12u3 in the two Rust runtimes

Alpine fixed `CVE-2026-11979` and five more in `libxml2 2.13.9-r5`, and Debian fixed `CVE-2025-6020` in `libpam-modules 1.5.2-6+deb12u3`. The frontend and adminer images now upgrade `libxml2` to r5, call-service and chat-gateway run `apt-get upgrade`, and adminer's `libpq` upgrade (a no-op since the base carries 18.7) is gone ([cicd](docs/wiki/cicd.md#container-images-are-scanned-2026-10-23)).
