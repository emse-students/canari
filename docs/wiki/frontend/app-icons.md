# App icons - one drawing, one set of rules, four generators

Every icon comes from [`frontend/static/favicon.svg`](../../../frontend/static/favicon.svg) and the
constants in [`frontend/scripts/icon-spec.mjs`](../../../frontend/scripts/icon-spec.mjs). Nothing is
drawn by hand per surface.

## Decisions (user, 2026-09-30)

- **The bird is HALF of what a person sees** (`BIRD_ICON_FILL = 0.5`), chosen on a contact sheet at
  40, 50 and 60 percent. It was too big everywhere and by different amounts: `0.76` of the iOS
  home-screen icon, and `0.5` of the Android adaptive CANVAS - where the launcher shows only the
  central 72 dp of 108, so the bird filled three quarters of what is visible. Two constants in two
  scripts had drifted apart; `ANDROID_VISIBLE` (72/108) reconciles them, and `ANDROID_LAUNCHER_ZOOM_COMPENSATION` (0.75) absorbs the ~1.48x zoom MEASURED on the Mi 9T launcher, where a bird at 0.5 of the window drew at 0.74 of the round icon, on the edge.
- **Background: a soft gradient centred on the brand navy** - `#1E2742` at the top, `#0E1220` at the
  bottom, `#151B2C` (the app's `--color-cn-ink` and `theme-color`) in the middle.
- **The yellow stays `#fac809`**, NOT the app's `--cn-yellow` (`#f6c232`). The logo is the identity,
  the token is the interface; changing it would change the logo on every surface.
- **The drawing is the old one, smoothed** (potrace over a 1 px blur of the hand tracing): same pose,
  open beak, wing groove. Redrawing the bird (shorter tail, bigger eye) was considered and declined.

## Two marks, and where each lives (user, 2026-09-30)

- **The LAUNCHER mark**: the bird alone on the gradient, half of what is seen. A system mask (Android
  adaptive, iOS squircle) cuts whatever leaves the frame, so it is the only form those surfaces can carry.
- **The PERCH mark**: the canary standing ON the bottom edge of a navy square, tail hanging out, on a
  TRANSPARENT ground (`perch-logo.mjs`). It stays where it already was, and only there: the Play listing,
  `og-canari.png` (link previews, JSON-LD), `src-tauri/icons/Canari.png`, the whole DESKTOP set (`.icns`,
  `.ico`, Windows tiles) and Portail-etu's Canari tile. Its geometry is MEASURED on the original, not
  chosen: square 67.9 percent of the canvas at the top right, bird 74.8 percent wide, feet 0.4 percent
  BELOW the square's lower edge. **The feet must rest on that edge** - every first redraw floated them inside.
- **The DEV mark**: the launcher mark with the gradient pulled from navy to violet (`DEV_TOP` /
  `DEV_BOTTOM`), so a pre-release is told from production on a home screen. `gen-android-icons.mjs --dev` and
  `gen-ios-icon.mjs --dev` write it into the working tree of the run, from a step that `android.yml` and
  `ios.yml` run only when `inputs.prerelease == 'true'`; it is never committed, because a pre-release has
  no application id of its own.

## Who writes what

| Generator | Writes |
| --- | --- |
| `gen-android-icons.mjs` | adaptive foreground and THEMED (monochrome) layers, legacy square and round icons, the gradient background drawable, the status-bar icon |
| `gen-web-icons.mjs` | `apple-touch-icon.png` (opaque), `favicon.ico` |
| `gen-native-icons.mjs` | the desktop set (`.icns`, `.ico`, Windows tiles) and `src-tauri/icons/ios`, through `tauri icon` |
| `gen-ios-icon.mjs` | `gen/apple/AppIcon.icon`, the Icon Composer document the app actually ships (the old `appiconset` is deleted) |
| `gen-icon-layers.mjs` | `store/icons/` (the store icons, the layers for an icon editor, the perch mark), `og-canari.png` and `src-tauri/icons/Canari.png` |

The Android files are NOT taken from `tauri icon`: it cannot express the gradient background, the
themed layer or the status-bar icon. `appIcons.test.ts` measures the bird's width off the pixels of
the home-screen, adaptive and legacy icons, so a constant changed in one script fails a test.

## Still open

- The iOS 26 icon is `gen/apple/AppIcon.icon` (clear / dark / tinted with the Liquid Glass treatment), written by
  `gen-ios-icon.mjs` WITHOUT the Mac application: the format is a folder (`icon.json` + artwork) and its
  schema is not published, so it is checked by `ios.yml`'s compile check, which builds it with Xcode 26 and
  dumps the compiled appearances. **Not yet compiled on a runner.** Liquid Composer was tried and exports
  baked PNG previews, not a `.icon` - unusable as an App Store icon (transparent corners, relief drawn twice).
- A distinct icon for **dev / pre-release builds** (tint or banner), so testers can tell them apart.
- `og-canari.png`, the splash screen, and the store listing graphics.
- Nothing above was looked at on a device: the gates are blind to how a launcher masks an icon.
