## P3 - two service images still run as root: the nginx frontend and media-service (Trivy DS-0002, 2026-10-23, narrowed 2026-11-11)

Six of the eight images run as a non-root user since 2026-11-11, asserted by
`.github/scripts/tests/image-user.test.mjs` ([cicd](../cicd.md#container-images-are-scanned-2026-10-23)).
The two left are in that test's `ROOT_ALLOWED`, each blocked by something a `USER` line cannot fix:

- **`Dockerfile.frontend` (nginx).** It listens on port 80, which a non-root process cannot bind,
  and nginx writes its pid and temp files under root-owned paths. The move: listen above 1024
  (`nginx-unprivileged` does 8080), and change that port in the edge's upstream lists, both compose
  files, the rolling-replace scripts and their fixture together; the `edge/targets` mount is
  read-only and is not the obstacle.
- **`Dockerfile.media-service`.** Its three named volumes (`media_meta`, `live_segments`,
  `upload_sessions`) hold files written by root on production and dev; a `USER bun` would make every
  write there fail until they are re-owned. The move: re-own each volume to uid 1000 on each estate
  (a one-off on the shared host, so the owner's, or an entrypoint step that does it), then the
  `USER`.

Done when both images carry a non-root `USER` and leave `ROOT_ALLOWED`; the test fails until the
entry is deleted.
