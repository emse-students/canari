### Fixed - sharing a live's link "via Canari" opened the destination picker behind the live viewer

The "Envoyer a..." picker of a share from another app sat on the modal rung, under the full-screen viewer, and was invisible until the live was closed. Its host now marks itself as a viewer-clearing layer, like the dialogs opened from inside a viewer ([live](docs/wiki/frontend/modules/live.md#the-viewer-as-built-2026-10-19)).
