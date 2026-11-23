### Changed - a resume no longer re-reads the key group of an unchanged private salon

The `1.8.0-alpha.1` reading showed the community key-group passes skipped on resume, while each private salon the account reads still made its two reads every time. The versions answer now carries each salon's version beside its community's, so a salon unchanged since its last converged pass makes no request ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#a-return-re-reads-the-key-group-only-of-a-community-that-changed-2026-11-22)).
