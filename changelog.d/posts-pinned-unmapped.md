### Changed - `posts.pinned`, the retired global pin, is no longer mapped by the post entity

No INSERT names the column any more, so a later release can drop it without failing the posts an
older container creates during the deploy ([legacy-compatibility](docs/wiki/legacy-compatibility.md#removable-at-floor-127)).
