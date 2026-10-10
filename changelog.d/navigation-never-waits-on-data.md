### Fixed - tapping a page no longer waits on the network

On a weak connection a tap on a post, or any page while the app was still unlocking, waited for a server round trip before anything appeared. The page now opens at once and its data fills in ([posts](docs/wiki/frontend/modules/posts.md#a-navigation-never-waits-on-data-the-post-page-and-the-root-layout-wp-nav-1-2026-10-10)).
