### Fixed - a MiGallery album card is sharp: its large banner draws the 1200x630 cover, not the 400px square stretched

The hero banner was upscaling the square tile cover about three times; it now draws the wide cover the preview already carried, and a private album keeps the square only ([chat-delivery](docs/wiki/services/chat-delivery.md#who-carries-the-migallery-key-and-who-does-not)).
