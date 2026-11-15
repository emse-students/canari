## Reading owed - the stricter script policy and the iOS 16 minimum

target: 1.7.0

**What is built:** the stricter script policy and the iOS 16 minimum (#2267, every stable since `1.5.0`; [cloudflare-edge](../infrastructure/cloudflare-edge.md#no-script-runs-unless-the-policy-names-it-2026-10-22))

**The reading that closes it:** the console read for policy refusals on the web, the Mi 9T and the iPhone 12; the edge features that inject scripts into a page checked against the policy

**Web half read 2026-11-15 on dev (a `securitypolicyviolation` listener installed before each document, one dev seat, 16 route loads: chat, communities, feed, calendar, directory, notifications, games, settings, lives, camera, dashboard, shop, help, profile, privacy text):** 17 violations in all, every one the same `script-src-elem` / `inline` refusal of the edge's injected JavaScript-detections script (one per document, the case [cloudflare-edge](../infrastructure/cloudflare-edge.md#no-script-runs-unless-the-policy-names-it-2026-10-22) documents and the owner's zone toggle clears); no other directive and no blocked URL. **Left on the web: the surfaces that open on a gesture (an image and a video in a chat, the GIF picker, the PDF viewer, a trombinoscope export) were not driven; and the Mi 9T console half.**

**Triage 2026-11-14: web (a dev seat, console) about 10 min, Mi 9T (CDP console) about 10 min.** The iPhone console half and the iOS 16 minimum are DELETED: the bench iPhone runs a recent iOS, there is no iOS 16 device, and WebKit's console is not reachable from the bench; the policy is one response header, read once in the browser and on the Android WebView.

**Mi 9T console half, READ 2026-11-15 on dev (`1.6.12-alpha.2`):** a `securitypolicyviolation` listener installed before each document over CDP, 14 route loads (chat, communities, feed, calendar, directory, notifications, games, settings, dashboard, shop, profile, help, bookings, forms): no violation. Control: an inline script injected into the page was refused and fired `script-src-elem | inline`, so the policy is enforced in the WebView and the listener works. **Left: the surfaces that open on a gesture (PDF viewer, trombinoscope export) on the web and the phone.**

**Gestures read 2026-11-15 on dev (`1.6.12-alpha.2`, web, [device-verification](../device-verification.md#where-the-pass-stands)):** a CanaReel in the chat viewer, an image and a PDF in their viewers, the GIF picker and the trombinoscope export: 0 `securitypolicyviolation`, no policy line beyond the edge's injected script. **Left: the Mi 9T console half only.**
