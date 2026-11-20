### Changed - the four NestJS service images ship production dependencies only

The runtime stage of the core, social, media and chat-delivery images copies a `--production` install instead of the builder's, so jest, the Nest CLI and the other dev tools are no longer on the image, in its size or in its scan ([cicd](docs/wiki/cicd.md#the-audit-blocks-on-what-we-ship-2026-11-17)).
