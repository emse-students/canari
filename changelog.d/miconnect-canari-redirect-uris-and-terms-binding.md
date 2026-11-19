### Security - MiConnect's three Canari clients accept only the redirect URIs their clients use, and dev asks for the terms

Production and dev lost their `tauri.localhost` and loopback callbacks (unused since April on production; loopback is the local client's alone), and the terms-of-use flow is now bound to the dev and local clients in the blueprints, so a stable no longer resets it and the pre-release apps can read it; production stays held ([authentik](docs/wiki/infrastructure/authentik.md#the-three-canari-providers-and-what-each-one-lets-a-client-come-back-to)).
