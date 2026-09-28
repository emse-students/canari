### Fixed - the carte warns only of associations that really overlap, and full screen covers the page

Overlaps are tested on the drawn blobs and cards rather than their bounding boxes (17 false pairs
became one real one), and the full-screen editor no longer lets the page show under it ([carte](docs/wiki/carte-vie-asso.md#an-overlap-is-reported-against-the-ink-and-never-repaired)).
