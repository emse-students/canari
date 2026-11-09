### Changed - section headings use the body font, headings lose their letter-spacing, and a settings section no longer says its name twice

Fredoka now carries only page titles, names and the wordmark; `h2..h6` are Nunito bold, no heading is tightened, and a settings card drops its icon tile and repeated heading ([design-reference](docs/wiki/frontend/design-reference.md)). The `h1` display-face rule now sits in `@layer base`, so a `font-body` opt-out on an `h1` finally wins (it was unlayered and beat every utility).
