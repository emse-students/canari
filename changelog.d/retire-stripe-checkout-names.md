### Removed - the `stripe` checkout return host and `paymentMethod` input

Builds below 1.2.4 named the checkout return `fr.emse.canari://stripe`; at `minClientVersion` 1.2.7
only `payment` is declared, accepted and routed, and a submission's `paymentMethod: 'stripe'` is a 400
([legacy-compatibility](docs/wiki/legacy-compatibility.md)).
