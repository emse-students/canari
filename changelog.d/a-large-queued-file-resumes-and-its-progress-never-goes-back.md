### Fixed - a queued chat file over 8 MiB resumes where it stopped, and its progress never goes back

On the iPhone a 13 MB file read 50 %, then 6 %: every attempt sent it again from byte 0. It now goes through a resumable upload session with two parts in flight, and the bubble never shows less than it did ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#139-a-queued-file-over-one-request-body-resumes-and-its-figure-never-goes-back-2026-11-16)).
