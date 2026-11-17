## P2 - A community joined from another device, or just joined, is not drawn until a cold start or a reload

target: 1.7.0

Two observations of 2026-11-17 on `1.7.0-alpha.8` ([readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha8-both-phones-one-sitting)), cause not established:

- **iPhone 12 (`gamma`)**: `gamma` had joined a community from its web seat; the iPhone app, brought
  back from suspended and left in the foreground for five minutes on the communities screen, did not
  list it (17 communities, the new one absent, the rail scrolled to its end). A `terminate` and a
  launch listed it at once.
- **Web seat (`delta`)**: right after joining a community by its link, the salon showed loading
  skeletons for about three minutes with messages sent after the join already on the server; a
  reload drew them.

Neither path logged an error that names it. The next reading captures the iPhone's in-app log across
the resume (`[WORKSPACE-LOAD]`, `[WORKSPACE-SNAPSHOT]`) and the web seat's console from the join,
to say whether the workspace event never arrived or arrived and was not applied.
