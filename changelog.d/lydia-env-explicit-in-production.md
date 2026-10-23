### Fixed - production names its Lydia environment explicitly

Production's `.env` inherited the template's `LYDIA_ENV=homologation`, so its Provider pair addressed Lydia's sandbox; `LYDIA_ENV` is now a `required` production secret, refused unless `production` or `homologation`, and dev keeps its compose literal ([payments](docs/wiki/frontend/modules/payments.md#which-payment-provider-is-live)).
