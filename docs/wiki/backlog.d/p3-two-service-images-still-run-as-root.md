## P3 - two service images still run as root: the nginx frontend and media-service (Trivy DS-0002, 2026-10-23, narrowed 2026-11-11)

target: 1.9.0

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

  **Measured 2026-11-14, read-only, both estates** (`docker exec` into each `media-service`): the
  container runs as `uid=0`; each of the three mount points is `0:0 755` and EVERY entry under them
  is root's (production: `media_meta` 2 entries / 304 KB, `live_segments` 3, `upload_sessions` 12;
  dev: 2 / 3 / 1); the image's `bun` user is `1000:1000`. Small, so the re-own is seconds; but
  `media_meta` holds the metadata index (`media_metadata.json`), so it is production data and the
  step is planned, not improvised.

  **The plan, in order (one pull request, then one deploy per estate):**
  1. `Dockerfile.media-service` creates `/app/media_meta`, `/app/live_segments` and
     `/app/upload_sessions` owned by `bun` and ends on `USER bun` - a NEW empty volume then takes its
     owner from the image, so a fresh estate is born right.
  2. `deploy-environment.sh`, before the media-service is recreated: for each of the THREE named
     volumes of its own compose project - an allowlist, never a pattern - a `docker run --rm --user 0`
     of the release's media image that re-owns it to `1000:1000` ONLY when `find ! -uid 1000` finds
     an entry (gated on the state being wrong, idempotent from the volume itself), logging the count it
     changed. Nothing is deleted or moved. Safe in both directions: a deploy that fails after it leaves
     the old root image running, and root writes uid-1000 files.
  3. `restore.sh` restores `media_meta` as root with `tar xzf`, which keeps the archived owners - so a
     backup taken after step 2 restores as `1000`; one taken before restores as root, and step 2's
     check is what re-owns it at the next deploy. The restore page says so.
  4. `image-user.test.mjs` loses the `Dockerfile.media-service` line of `ROOT_ALLOWED`.
  5. The reading: on dev after the pre-release, then production - `id` reads `uid=1000`, 0 `EACCES`,
     one upload (`upload_sessions`), one live segment, and the metadata index rewritten
     (`media_metadata.json` mtime moves).

Done when both images carry a non-root `USER` and leave `ROOT_ALLOWED`; the test fails until the
entry is deleted.
