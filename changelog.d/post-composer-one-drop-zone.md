### Fixed - dropping a file or an image into the post composer attaches it

The whole post sheet is now one drop zone with a visible drop state (padding, media strip and toolbar used to let the browser handle the drop), the announced drop effect follows the source (forcing `copy` made the browser refuse an image dragged from a web page), and an image with no file is fetched when its host allows it, else a toast says why ([chat](docs/wiki/frontend/modules/chat.md)); browser reading owed.
