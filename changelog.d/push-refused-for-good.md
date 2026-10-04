### Fixed - a push MLS cannot read at any later epoch no longer pays a catch-up and a worker

A spent generation or a same-epoch refusal now comes back as `mls-refused-for-good`, so the Android service and the iOS extension show the generic banner without fetching commits or enqueuing `MlsBackgroundWorker` ([mobile](docs/wiki/frontend/mobile.md#background-mls-decrypt-ladder)).
