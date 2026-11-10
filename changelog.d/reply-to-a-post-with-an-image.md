### Added - a post can be answered with an imported image, and a comment's picture is validated on the server

An image button beside GIF in the comment box picks one photo from the library (compressed, encrypted and uploaded before the comment can be sent, with a retry when the upload fails), and the server now refuses a comment picture that is not a bounded image ([posts](docs/wiki/frontend/modules/posts.md#reply-with-an-imported-image-2026-11-09)).
