## P1 - Every site refuses to run inside a Meta in-app browser and sends the visitor out

target: 1.8.2

Owner decision of 2026-11-25 ([decisions](../decisions/owner-decisions-of-2026-11-25.md)): Canari,
MiConnect, MiGallery, Sky, Le Cercle and Portail-etu answer a page request from the browser built
into Messenger, Facebook, Instagram or Threads with one blocking page, which leaves automatically
where the platform allows (Android: a no-package https VIEW intent; iOS 17+: `x-safari-https://`)
and otherwise gives the manual instruction and a copy button. Link-preview crawlers are never
blocked. Mechanism: [leaving-in-app-browsers](../frontend/leaving-in-app-browsers.md).

**Built** (Canari's pull request): the shared definition `libs/leave-in-app-browser/`, Canari's hook
and app-shell guard, MiConnect's generated `gate` service, rehearsed on a throwaway stack.

**Owed, in order:**

1. The owner's one-off Cloudflare Cache Rule for dev ([the exact rule](../frontend/leaving-in-app-browsers.md#devs-cloudflare-cache---the-owners-one-off-rule)).
2. The owner's readings on the `1.8.2` pre-release ([the list](../frontend/leaving-in-app-browsers.md#4-what-the-owner-reads-on-his-phone)).
3. MiConnect's `gate` on production, a hand step by the lead ([the step](../frontend/leaving-in-app-browsers.md#miconnect-in-production---the-hand-step)).
4. Sky, MiGallery, Portail-etu and Le Cercle, one pull request each ([the plan](../frontend/leaving-in-app-browsers.md#6-the-siblings---sky-migallery-portail-etu-le-cercle)).
