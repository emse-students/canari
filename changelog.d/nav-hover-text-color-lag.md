### Fixed - the sidebar nav label lagged the background on hover

The label span's own 300ms/delayed transition (for its expand/collapse slide-in) was bundling the
inherited hover color change too, so the background switched color noticeably before the text did.
Color now transitions on its own 200ms/no-delay timing, matching the row
([chat](docs/wiki/frontend/modules/chat.md)).
