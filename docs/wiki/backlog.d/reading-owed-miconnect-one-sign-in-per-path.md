## P2 - Reading owed - MiConnect asks each sign-in once, on every path, with a real Alumni account

target: 1.8.3

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

**Built 2026-11-25** (the owner's request: no second sign-in, the most fluid path): the routing
page's "I have a School account" links the identity Alumnforce just asserted after the CAS (names
agree: at once; differ: a page naming both), and the link step's link resumes the application's
sign-in with no D49 page. Every path, its counts and the boundary:
[miconnect-sign-in-paths](../infrastructure/miconnect-sign-in-paths.md). CI drives each on a
throwaway authentik with the IdP round trips emulated; what only a real Alumnforce can show is owed
here, on production, after the stable carrying it, with a real Alumni account at a browser.

The readings that close it (PASS = the counts of the "After" column of the paths table):

1. **P6, names agree**: signed out, open an application, Alumni button -> Alumnforce -> the routing
   page -> "I have a School account" -> the CAS (no login page in between) -> the application, with
   no second Alumnforce sign-in and no confirmation page. The account holds the Alumni link, its
   `attributes.alumni.read_on` is today, and an Event `source_linked` with `miconnect_route`
   `routing` is journalled.
2. **P6, names differ** (an account whose MiConnect name differs from the Alumni one): the same,
   and one page naming BOTH accounts; nothing linked before the tick; the tick ends on the
   application.
3. **P8 and P9, the link step**: a CAS account with the reminder due, then one with the block due
   -> "Lier mon compte Alumni" -> Alumnforce once -> the SAME application, signed in, with no D49
   page and no Settings page. Read once on the native app (the authentication browser ends on the
   app's redirect URI).
4. **P11 unchanged**: Settings > Sources "Connect" still shows the D49 page and ends on Settings.

A reading that shows a second Alumnforce sign-in, a D49 page on paths 1-3, or a landing on
Settings instead of the application is the defect, and its fix belongs in the link flow
(`30-sources.yaml`).
