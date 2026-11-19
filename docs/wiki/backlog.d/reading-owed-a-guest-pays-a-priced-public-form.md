## Reading owed - a guest with no account pays a priced public form through Lydia, on dev (audited 2026-11-19)

target: 1.7.1

**Built, and no longer waiting for Lydia** (Lydia is live in production since 2026-11-06): the free half
(`/f/:id`, #1270), then the paid half - WP-P1 a guest pays with the e-mail it types (#2229), WP-P2 the
receipt page (#2230), WP-P3 at most three answers waiting per visitor (#2231), WP-P4 the documentation
(#2232) - and since then the guest's name and e-mail asked by the form (#3096) and the guest link
reaching `/f/:id` signed out (#3159). Mechanism: [forms](../frontend/modules/forms.md#the-paid-half-what-it-needs-scoped-2026-09-30),
[payments](../frontend/modules/payments.md), [public-paid-forms-chantier](../public-paid-forms-chantier.md).

**The reading that closes it, never taken on a device or against Lydia** (no sitting of
[device-verification](../device-verification.md) records one): from a private window on
`dev.canari-emse.fr`, one guest answer to a PRICED public form sent through to Lydia's homologation
page and back: the receipt page at `/f/:id/receipt?receipt=...` shows the state and its reference, the
row is `paid`, and the `canari-dev-frontend-1` log shows a real client address rather than the Docker
gateway (the `real_ip` change). A real production payment stays the owner's.
