### Fixed - a page that crashes says where again, and offers Retry rather than the sign-in page

Under SvelteKit 3 Kit's own boundary catches a page crash before the layout's could, so the log lost the route and the screen sent a signed-in reader to `/login`; the client error hook now names the route and the error page retries ([architecture](docs/wiki/frontend/architecture.md#a-page-that-crashes)).
