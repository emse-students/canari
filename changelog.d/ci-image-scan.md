### Security - every container image an estate runs is scanned

A Trivy scan of the runtime bases and third-party images gates `CI passed`, with a self-retiring allowlist; the postgres 18 digest and nginx 1.31.8 it found fixable move with it ([cicd](docs/wiki/cicd.md#container-images-are-scanned-2026-10-23)).
