### Fixed - The web build no longer dies compressing the emoji pictures

The web build wrote a `.gz` and a `.br` beside each of its ~4400 emoji pictures, all at once, and
failed with `EMFILE`; nginx never served one of them. `precompress` is off (`frontend/svelte.config.js`).
