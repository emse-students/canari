### Changed - a preview's image follows its redirects the way the page does

The image proxy of a link preview now walks a redirect chain one hop at a time, each hop checked
before it is fetched, through the same code as the page fetch (5 redirects for an image, 3 for a
page) ([chat-delivery](docs/wiki/services/chat-delivery.md#preview-images-are-proxied-so-the-site-never-sees-the-reader)).
