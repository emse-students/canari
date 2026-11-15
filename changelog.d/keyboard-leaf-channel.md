### Changed - the Android keyboard ride starts without a whole-document style pass, and popovers ride it

The keyboard announcement now writes the riding pieces' own non-inherited twins and writes `:root` only
once the ride's first frame is out (any `:root` write cost 17-30 ms of style on the Mi 9T); emoji
pickers, mentions and floating surfaces ride the keyboard instead of jumping a frame late
([the leaf channel](docs/wiki/frontend/keyboard-and-send-motion.md#6-android-since-2026-11-14---the-keyboard-covers-the-webview-and-the-page-rides-it)).
