### Fixed - a deploy tells an unreachable registry from a broken change

The registry login and image pull are re-attempted three times, then fail with exit 75 under the title `Registry unreachable - not a broken change` ([dev-environment](docs/wiki/infrastructure/dev-environment.md#the-deploy-is-two-scripts-and-the-order-is-load-bearing)).
