## P2 - the thread glide never plays on Chromium, and warns at every arrival (S14, 2026-11-20)

target: 1.7.2

Read on `1.7.1-alpha.6` (dev), the Mi 9T's WebView and desktop Chrome
([S14](../device-verification.md#the-readings-of-2026-11-20-s14-171-alpha6-replays-on-both-phones-messages-on-the-mi-9t-the-reactions-at-two-widths)):
every message that arrives into an open thread logs `[threadGrowth] glide of <N>px skipped: the motion tokens did not
resolve` at WARN (4 lines on the Mi, 28 across the web seats' consoles in one sitting), and the glide itself does not play.

Cause as far as it was read: `getComputedStyle(document.documentElement).getPropertyValue('--motion-thread-glide')`
answers `.22s` on both Chromium surfaces (read live), while `motionMs` in
`frontend/src/lib/utils/chat/threadGrowthObserver.ts` accepts only `<n>ms` (`220ms` in `app.css`), so it returns null
and `play` gives up. The feature has therefore never run where the engine normalises the token (present since #3490).
The iPhone's WKWebView logged no such line in S13, so it may return the specified text; not read here.

Fix to decide: read the token as a time (`ms` or `s`) in ONE parser, shared with every `--motion-*` reader, and test the
`.22s` form. Not a regression of `1.7.1` and nothing is lost (an animation is skipped), but a WARN on every arrival is
noise the charter refuses: a line is either expected and necessary or the visible end of something upstream.
