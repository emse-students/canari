### Changed - every PDF on screen shares one pdf.js worker

A thumbnail or the reader no longer starts and tears down a worker of its own: one is created on the first PDF and reused, so a salon with several PDFs loads the 1 MB worker once per session ([web-console-log-audit](docs/wiki/frontend/web-console-log-audit-2026-10-12.md#one-worker-for-every-pdf-shipped-after-the-audit)).
