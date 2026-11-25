### Fixed - a tap on an agenda, moderation or notifications push from a closed app lands on its page

The link arrived before SvelteKit's first navigation had settled and its `goto` threw; every app link now waits for the router, which the root layout declares ready in its first `afterNavigate` ([mobile](docs/wiki/frontend/mobile.md#how-a-deep-link-actually-reaches-the-app--two-paths-only-one-of-them-gated)).
