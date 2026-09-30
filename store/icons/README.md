# store/icons - the store icons and the layers for an icon editor

Generated, not drawn: `cd frontend && bun scripts/gen-icon-layers.mjs`. The rules (bird size,
gradient, yellow) are in `frontend/scripts/icon-spec.mjs`; the why is in
[app-icons](../../docs/wiki/frontend/app-icons.md).

| File | For |
| --- | --- |
| `play-store-512.png` | The Google Play listing icon (512 px, opaque, full-bleed - Play cuts the corners) |
| `app-store-1024.png` | The App Store icon (1024 px, opaque: the store refuses an alpha channel) |
| `layers/bird.svg`, `layers/bird-2048.png` | The bird alone, transparent, centred, half of the canvas wide |
| `layers/bird-mono-2048.png` | Its flat white silhouette, for tinted / monochrome modes |
| `layers/background.svg`, `layers/background-2048.png` | The navy gradient, full canvas |
