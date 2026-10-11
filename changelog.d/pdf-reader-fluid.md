### Fixed - the PDF reader is fluid on a phone, and its text selection matches the glyphs

Pages are shown as canvases instead of PNG-encoded images, rendered through a bounded, cancellable
queue with a memory budget; on a Mi 9T an 81-page scan shows its first page in 0.65 s instead of 5 s
and no longer freezes on zoom. The selectable text was about font-size times too wide on every PDF
([posts](docs/wiki/frontend/modules/posts.md#making-the-reader-fluid-on-a-phone-2026-10-11)).
