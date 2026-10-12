### Security - quinn-proto 0.11.18 in the three crates that carry it

Three advisories (RUSTSEC-2026-0338, -0340, -0343) turned `cargo audit` red on `main`; the lock files of `apps/call-service`, `apps/chat-gateway` and `frontend/src-tauri` move to the fixed release, nothing else changes ([cicd](docs/wiki/cicd.md)).
