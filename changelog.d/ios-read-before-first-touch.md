### Fixed - iPhone: a conversation opened from a banner is read without a touch

The iPhone's WebView reports no focus until the first touch, so a conversation landed from a banner tap was neither marked read nor had its other banners removed; on a phone the app's own foreground now decides ([reading](docs/wiki/device-verification.md#the-iphone-12-readings-of-2026-11-26-evening-182-build-100800209-five-iphone-entries-and-a-read-withheld-until-the-first-touch)).
