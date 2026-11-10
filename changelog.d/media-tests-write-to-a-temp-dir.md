### Fixed - the media-service test suite no longer deletes committed files

Each media-service test file now runs in a temporary working directory of its own (`apps/media-service/jest.temp-cwd.cjs`), so a run no longer rewrites the `chunks_temp` directory that was committed under the package; that directory and the service's other runtime directories are now ignored, not tracked. See [media-service](docs/wiki/services/media-service.md#the-test-suite-runs-each-file-in-a-temporary-directory-2026-11-09).
