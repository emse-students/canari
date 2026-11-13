## P2 - the historical-account bridge: the BDE's and Le Cercle's switch readings are owed

Built (owner, 2026-11-13), in the release after `1.6.11`: an association whose historical Lydia
account collects keeps collecting there until Lydia validates the Business its enrolment created,
then switches by itself; error 5 on the switched-to Business switches back and re-issues the same
payment once ([payments](../frontend/modules/payments.md#a-historical-account-collects-until-the-enrolled-business-is-validated-owner-2026-11-13)).
Nothing is open on production yet: the bridge rows are written by hand after the deploy (the
generic steps are in that section; the values stay in the private operations notes).

Owed, per association (the BDE first, then Le Cercle):

- the bridge opened and the parked Business put PENDING; one real payment read on the historical
  account (`product_checkouts."vendorToken"`), the managers' screen showing only the new Business;
- Lydia's `BUSINESS_VALIDATED` read in core's log, the `[LYDIA-BRIDGE] ... SWITCHED` WARN, the next
  real payment read on the new Business, and the managers' single "active" notice;
- one refund of a payment the historical account took, after the switch, confirmed at Lydia;
- the counts on the global admin's panel (`switchBackCount`, `reissueCount`): any non-zero value is
  read in the logs (`[LYDIA-BRIDGE]` ERROR) before anything else.

The entry closes when both have switched and their readings are in; the bridge itself goes by the
[legacy-compatibility](../legacy-compatibility.md#removal-once-no-association-is-left-with-a-historical-active-account---the-lydia-account-bridge-owner-2026-11-13) condition.
