### Changed - social-service pins `TZ=UTC` in its image and compose files

Its zone-less `submissions` timestamps are read in the process zone, so the anonymous week cut and the
XLSX dates were right only while the base image happened to run UTC; a test now holds the pin
([forms](docs/wiki/frontend/modules/forms.md#an-anonymous-answer-keeps-only-its-week-2026-11-22)).
