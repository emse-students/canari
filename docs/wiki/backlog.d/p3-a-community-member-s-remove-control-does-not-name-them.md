## P3 - a community member's remove control does not name them for a screen reader (2026-11-17)

target: 1.7.1

Read on the Mi 9T and the iPhone 12, `1.7.0-alpha.10`
([readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha10-both-phones-and-the-rig)):
in the community settings' "Membres" tab every row's trash carries `aria-label="Retirer le membre"`,
so a screen reader hears the same words on every row, while the group panel's control reads
"Retirer <name>". The confirmation names the member since #3797, so a wrong tap is caught there; the
label is what is left. The label belongs in Paraglide with a `{member}` parameter, as the group
panel's already is. Not a regression since `v1.6.12` (the label predates #3797).
