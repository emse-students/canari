### Fixed - on a weak link, five chains of reads that waited for each other now leave together, and a push registration is no longer refused at a cold start

Key-group status reads at every connection, a person's profile, repeated photo-presence questions and the dismissed-groups read no longer wait in series; push registration was counted in one rate-limit bucket shared by the whole estate and now counts per user ([weak-network-audit-2026-11-10](docs/wiki/frontend/weak-network-audit-2026-11-10.md)).
