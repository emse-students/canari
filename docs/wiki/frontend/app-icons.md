# App icons - one drawing, one set of rules, four generators

Every icon comes from [`frontend/static/favicon.svg`](../../../frontend/static/favicon.svg) and the
constants in [`frontend/scripts/icon-spec.mjs`](../../../frontend/scripts/icon-spec.mjs). Nothing is
drawn by hand per surface.

## Decisions (user, 2026-09-30)

- **The bird is HALF of what a person sees** (`BIRD_ICON_FILL = 0.5`), chosen on a contact sheet at
  40, 50 and 60 percent. It was too big everywhere and by different amounts: `0.76` of the iOS
  home-screen icon, and `0.5` of the Android adaptive CANVAS - where the launcher shows only the
  central 72 dp of 108, so the bird filled three quarters of what is visible. Two constants in two
  scripts had drifted apart; `ANDROID_VISIBLE` (72/108) is what reconciles them.
- **Background: a soft gradient centred on the brand navy** - `#1E2742` at the top, `#0E1220` at the
  bottom, `#151B2C` (the app's `--color-cn-ink` and `theme-color`) in the middle.
- **The yellow stays `#fac809`**, NOT the app's `--cn-yellow` (`#f6c232`). The logo is the identity,
  the token is the interface; changing it would change the logo on every surface.
- **The drawing is the old one, smoothed** (potrace over a 1 px blur of the hand tracing): same pose,
  open beak, wing groove. Redrawing the bird (shorter tail, bigger eye) was considered and declined.

## Who writes what

| Generator | Writes |
| --- | --- |
| `gen-android-icons.mjs` | adaptive foreground and THEMED (monochrome) layers, legacy square and round icons, the gradient background drawable, the status-bar icon |
| `gen-web-icons.mjs` | `apple-touch-icon.png` (opaque), `favicon.ico` |
| `gen-native-icons.mjs` | the desktop set (`.icns`, `.ico`, Windows tiles) and `src-tauri/icons/ios`, through `tauri icon` |
| `gen-ios-icon.mjs` | `gen/apple/AppIcon.icon`, the Icon Composer document the app actually ships (the old `appiconset` is deleted) |
| `gen-icon-layers.mjs` | `store/icons/`: the Play and App Store icons and the bird / background layers an icon editor takes |

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
