### Changed - the image scan allowlists apt's advisory in the authentik image (owner, 2026-11-05)

`CVE-2026-109518` (apt 3.0.3) failed every scan from 2026-11-05. apt runs only while upstream builds the image, never at runtime, and no authentik release ships the fix yet ([cicd](docs/wiki/cicd.md)).
