### Fixed - Authentik login CSS: a stretched card and unreadable input text

`.pf-c-login`'s page-sizing rule (`min-height: 100vh` + flex-centering) was also applied to
`ak-flow-card`/`.pf-c-form__group`, stretching the card itself and leaving empty space below short
content (e.g. the `redirect_uri` error page). The light input text color was gated on
`input[type='text'|'password'|'email']`, so a first-connection field with no/other `type` kept the
dark background but not the light text. Both fixed in `infrastructure/authentik/custom-login.css`;
still needs the usual manual paste into the live Brand
([authentik](docs/wiki/infrastructure/authentik.md#login-page-branding)).
