### Fixed - turning payments on platform-wide puts the withheld boutique products on sale

Switching `payment_provider` away from `disabled` now tells social-service to release every product withheld by the payment gate (never one an admin deactivated), for each association whose payment target is ready. See [cotisations](docs/wiki/cotisations.md).
