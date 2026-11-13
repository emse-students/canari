### Changed - six service images run as a non-root user

The four Bun services, the SSR server and the two Rust services no longer run as root; the nginx
frontend and media-service stay root for named reasons, and a test keeps both lists
([cicd](docs/wiki/cicd.md#container-images-are-scanned-2026-10-23)).
