### Fixed - the phone apps read Canari's API through the WebView, and the feed refreshes itself back online

A first-party read's body took 3.5-4.3 s through the HTTP plugin during a cold start (3-13 ms through the WebView), which kept the feed's stored copy on screen; back online after an offline start the feed now asks again by itself ([posts](docs/wiki/frontend/modules/posts.md#the-stored-copy-stayed-on-screen-for-the-plugins-body-read-2026-10-15)).
