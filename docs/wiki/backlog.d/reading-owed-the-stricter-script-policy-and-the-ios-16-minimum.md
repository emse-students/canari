## Reading owed - the stricter script policy and the iOS 16 minimum

target: 1.7.0

**What is built:** the stricter script policy and the iOS 16 minimum (#2267, every stable since `1.5.0`; [cloudflare-edge](../infrastructure/cloudflare-edge.md#no-script-runs-unless-the-policy-names-it-2026-10-22))

**The reading that closes it:** the console read for policy refusals on the web, the Mi 9T and the iPhone 12; the edge features that inject scripts into a page checked against the policy

**Triage 2026-11-14: web (a dev seat, console) about 10 min, Mi 9T (CDP console) about 10 min.** The iPhone console half and the iOS 16 minimum are DELETED: the bench iPhone runs a recent iOS, there is no iOS 16 device, and WebKit's console is not reachable from the bench; the policy is one response header, read once in the browser and on the Android WebView.
