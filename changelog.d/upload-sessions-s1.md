### Added - resumable streamed upload sessions (media-service, WP-S1)

Parts of at most 8 MiB are streamed to a staging file, resumable and completed once; large staged uploads reach the store in 5 MiB parts and a failed one is aborted. Unproven against Garage until a real 6 MB and 50 MB upload is read on dev ([media-service](docs/wiki/services/media-service.md#upload-sessions-streamed-resumable-every-body-under-8-mib-wp-s1-2026-10-10)).
