# App icons - one drawing, one set of rules, four generators

Every icon comes from [`frontend/static/favicon.svg`](../../../frontend/static/favicon.svg) and the
constants in [`frontend/scripts/icon-spec.mjs`](../../../frontend/scripts/icon-spec.mjs). Nothing is
drawn by hand per surface.

## Sizes (owner, 2026-11-15) - the bird was too small

**The owner's report**: on Android the icon looks small next to other apps. Measured the same day
on the two bench phones' home screens (glyph = the pixels that differ from the icon's own plate;
artwork that fills the whole icon, such as a full-bleed photo, left out of the median):

| | Canari | The apps around it |
| --- | --- | --- |
| Mi 9T app drawer (Launcher3, round mask) | bird **36.4 %** of the disc, ink 5.6 % | median **75 %** (59-83 %, 23 apps), ink ~28 % |
| iPhone 12 home screen | bird **49 %** of the tile, ink 7.3 % | median **75 %** (65-86 %, 21 apps), ink ~33 % |

The committed Android foreground drew the bird **27 dp** wide on the 108 dp canvas, where Google's
adaptive-icon guidance says *"Use a logo that's at least 48x48 dp. It must not exceed 66x66 dp"*.
Two more things make it read even smaller than those numbers: the bird is a thin diagonal
silhouette (it inks 5-7 % of its icon where a filled logo inks 25-40 %), and the navy plate stands
at 1.1-1.4 : 1 against a dark launcher background, so on a dark home screen only the bird is seen.

**The "launcher zoom" of 2026-09-30 was a misreading.** `ANDROID_LAUNCHER_ZOOM_COMPENSATION` (0.75)
was justified by a capture in which a bird "at 0.5 of the window" drew at 0.74 of the round icon,
read as a ~1.48x zoom. The 2026-11-15 capture refutes it: the spec gave 0.5 x 0.75 = 37.5 % of the
window, and the launcher showed **36.4 %** - the 72 dp window, 1:1, as the platform defines it.
0.74 is exactly what the PREVIOUS foreground gives (bird at 0.5 of the 108 dp CANVAS = 0.5 x 108/72
= 0.75 of the window), and the constant landed in the same commit as the resize, so the capture was
almost certainly of a build still carrying the old layer. The effect was that the owner's 50 % was
applied, then cut by another quarter: Android showed 37.5 %.

**The decision**:

- **Android: the bird is `ANDROID_BIRD_DP = 48` dp wide** on the 108 dp canvas - Google's minimum,
  2/3 of the window, 1.78x the old size. The bird's enclosing circle is 0.667 of its width, so its
  tips reach 32.2-32.5 dp from the centre, inside the 66 dp safe circle (r = 33) that no OEM mask
  cuts; 49 dp is the ceiling. The compensation constant is deleted. The themed (monochrome) layer
  follows. `appIcons.test.ts` asserts Google's two bounds on every density of both layers: at least
  48 dp wide (two pixels of slack for the pixel grid), and no ink beyond 33 dp from the centre.
- **iOS and the web: `BIRD_ICON_FILL = 0.66`** of the square icon (was 0.5). Its tips reach 0.44 of
  the edge from the centre, inside the squircle. This supersedes the 2026-09-30 50 % below, for iOS,
  the App Store master and the apple-touch-icon.
- **The background stays the navy gradient**, unchanged.
- **The legacy `mipmap-*/ic_launcher.png` and `ic_launcher_round.png` are deleted**, and with them
  `makeLegacy`: `minSdk` is 28, so every device resolves `@mipmap/ic_launcher` (the manifest and
  `IncomingCallActivity`) to the adaptive XML in `mipmap-anydpi-v26`, and the manifest declares no
  `roundIcon`. They were drawn and never shown.
- **Owed, one reading**: the iOS dark and tinted appearances with the new size (Home Screen set to
  Dark, then Tinted, by hand), and the Android drawer with the new foreground, on the next pre-release.

## Decisions (user, 2026-09-30)

- ~~**The bird is HALF of what a person sees** (`BIRD_ICON_FILL = 0.5`)~~ - **superseded on 2026-11-15**
  (above): 0.66 on iOS and the web, 48 dp on Android. Chosen then on a contact sheet at 40, 50 and
  60 percent. It was too big everywhere and by different amounts: `0.76` of the iOS home-screen
  icon, and `0.5` of the Android adaptive CANVAS - where the launcher shows only the central 72 dp
  of 108, so the bird filled three quarters of what is visible. Two constants in two scripts had
  drifted apart, and the reconciliation added a "launcher zoom" compensation that was a misreading
  (above).
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
| `gen-android-icons.mjs` | adaptive foreground and THEMED (monochrome) layers, the gradient background drawable, the status-bar icon (no legacy bitmap: `minSdk` 28) |
| `gen-web-icons.mjs` | `apple-touch-icon.png` (opaque) and its byte-identical twin `apple-touch-icon-precomposed.png` (the older name probed by Safari and crawlers, a 404 on production until 2026-11-13; a copy in `static/`, served like the other icons), `favicon.ico` |
| `gen-native-icons.mjs` | the desktop set (`.icns`, `.ico`, Windows tiles) and `src-tauri/icons/ios`, through `tauri icon` |
| `gen-ios-icon.mjs` | `gen/apple/AppIcon.icon`, the Icon Composer document the app actually ships (the old `appiconset` is deleted) |
| `gen-icon-layers.mjs` | `store/icons/` (the store icons, the layers for an icon editor, the perch mark), `og-canari.png` and `src-tauri/icons/Canari.png` |

The Android files are NOT taken from `tauri icon`: it cannot express the gradient background, the
themed layer or the status-bar icon. `appIcons.test.ts` measures the bird off the pixels of the
home-screen icon, the App Store master and every density of the adaptive layers, so a constant
changed in one script fails a test.

## Still open

- The iOS 26 icon is `gen/apple/AppIcon.icon` (clear / dark / tinted with the Liquid Glass treatment), written by
  `gen-ios-icon.mjs` WITHOUT the Mac application: the format is a folder (`icon.json` + artwork) and its
  schema is not published, so it is checked by `ios.yml`'s compile check, which builds it with the pinned Xcode (27 since 1.8.0) and
  dumps the compiled appearances. **Not yet compiled on a runner.** Liquid Composer was tried and exports
  baked PNG previews, not a `.icon` - unusable as an App Store icon (transparent corners, relief drawn twice).
- A distinct icon for **dev / pre-release builds** (tint or banner), so testers can tell them apart.
- The store listing graphics other than the icons above (screenshots, feature graphic).
- The gates are blind to how a launcher masks an icon: the sizes were read on the two bench phones on
  2026-11-15 (above), and the new size is owed the same reading.

## Launch screens

The perch composition on a transparent ground is the logo of the native launch screens, drawn over
the screen's own background colour: `LaunchLogo.imageset` + `LaunchScreen.storyboard` on iOS,
`drawable/launch_background.xml` (every version) and `windowSplashScreenAnimatedIcon` in
`values-v31/themes.xml` on Android. `scripts/gen-splash-logo.mjs` writes them. The web splash in
`app.html` (bird + name on black) is unchanged.

**The first iPhone that looked showed the ground and NO LOGO (iPhone 12, iOS 27.0.1, bench build of
`0.18.32` from `a081f7d3e`, 2026-10-01) - and the built app is right.** Read out of that very IPA:
the compiled `LaunchScreen.storyboardc` holds a `UIImageView` 160 x 160 pt, centred by two
constraints, `scaleAspectFit`, whose image is the catalogue name `LaunchLogo`; `Assets.car` holds
`LaunchLogo` at 1x/2x/3x (160/320/480 px, BGRA, no appearance variant); the ground resolves from the
same catalogue (`AppBackground`, navy in dark) and DID show. What the phone showed is exactly the
launch screen of every build since 2026-08-28 - that ground, no image - which is what iOS's cached
launch snapshot would draw: a bench build carries the store band's `CFBundleVersion` (`1803299` for
every `0.18.32`), so installing over an older `0.18.32` is no version change, and the cache is
widely reported to survive a deletion until the phone restarts. **Owed ONE look, and it settles
it**: delete the app, RESTART the iPhone, install, cold-launch. A logo means the cache and nothing to
ship; still none means the snapshot cannot draw this image and the storyboard is what changes next.
