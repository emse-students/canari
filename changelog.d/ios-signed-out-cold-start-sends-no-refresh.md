### Fixed - a signed-out iOS cold start no longer asks for a refresh that cannot succeed

Where no cookie can carry the session (iOS), an empty carried credential is the answer, so no recovery
refresh is sent ([sessions](docs/wiki/sessions.md#the-credential-a-client-carries-itself)).
