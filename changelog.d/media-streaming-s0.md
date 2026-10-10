### Documented - media streaming upload, WP-S0 measured: the phone's HTTP plugin is the real cost

On the Mi 9T a 13.4 MB upload peaks at about 1.5 GB in the app and 0.8 GB in the WebView, and 50 MB crashes the app, because the Tauri HTTP plugin turns every body byte into a JSON number; the audit of every media-ref surface and the minio buffering are on [media-streaming-upload](docs/wiki/services/media-streaming-upload.md#9-wp-s0-results-2026-10-10---what-the-audit-the-phone-and-the-code-say).
