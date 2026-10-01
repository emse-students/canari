### Added - the segmented writer's whole path is tested with the flag ON, and the flag is one module

`SEGMENTED_MEDIA_WRITER_ENABLED` moves to `mediaSegmentedWriterFlag.ts` (still `false`); an
end-to-end test replaces that one module and runs upload, ranged streaming, seek and whole-blob read
([media-service](docs/wiki/services/media-service.md#the-writer-flip---what-this-release-does-not-do)).
