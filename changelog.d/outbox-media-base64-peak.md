### Fixed - queuing a large attachment no longer builds a string per byte

The base64 of a queued file was a per-byte string concatenation and a callback-per-character decode, about 1 GB of transient heap for a 13 MB file; it is now chunked and byte-identical, and the queue logs how long its durable write and payload read take. The file still sits inside the row: design in [backlog](docs/wiki/backlog.md).
