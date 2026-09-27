### Fixed - the exported poster fits its directory and prints at 154 dpi

The directory's font fit ran in an animation frame, which a hidden tab throttles: an export could
capture the unfitted list and print three associations off the page. The exporter runs the fit
itself now, and the background raster goes from 102 to 154 dpi on A0
([carte-vie-asso](docs/wiki/carte-vie-asso.md#a-capture-cannot-wait-for-an-animation-frame)).
