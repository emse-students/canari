### Fixed - production names its Lydia environment explicitly, and accepts only `production`

Production's `.env` inherited the template's `LYDIA_ENV=homologation`, so its Provider pair addressed Lydia's sandbox; `LYDIA_ENV` is now a `required` production secret and the render accepts only `production` there, a local copy of production gets the sandbox and no Provider token, and rolling back to a release before this one needs a manual recreate ([payments](docs/wiki/frontend/modules/payments.md#which-payment-provider-is-live)).
