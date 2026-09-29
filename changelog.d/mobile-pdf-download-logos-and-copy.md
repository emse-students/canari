### Fixed - the agenda PDF saves on a phone, its logos are drawn, and post text can be copied

`pdf.save()` is an `<a download>` a WebView drops, so every PDF export went through the shared
download path instead, and the sheet's association logos are absolutized like every other stored
asset ([calendar](docs/wiki/frontend/modules/calendar.md#the-sheet-on-a-phone-no-logos-and-a-download-button-that-did-nothing-2026-09-29), [mobile](docs/wiki/frontend/mobile.md)). Rendered Markdown is selectable again on a touch screen ([posts](docs/wiki/frontend/modules/posts.md#a-posts-text-could-not-be-copied-on-a-phone-because-nothing-marked-it-as-content-2026-09-29)).

### Added - a copy button on a claimed partnership code

The code is pasted into a partner's checkout, so it is one tap away rather than a long press ([social-service](docs/wiki/services/social-service.md#a-claimed-code-is-copied-by-a-button-not-by-a-long-press-2026-09-29)).
