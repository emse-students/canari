### Fixed - on iOS the native "+" and header pieces are placed at the document position, so a keyboard rise no longer strands them one keyboard height above the composer

The page believed its document scrolled by the keyboard overlap while the screen drew it at offset 0 (measured on the iPhone 12, 2026-11-04) ([mobile](docs/wiki/frontend/mobile.md#the-dm-whose-chrome-stands-one-keyboard-too-high-2026-10-17)).
