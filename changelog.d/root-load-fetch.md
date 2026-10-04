### Fixed - no `window.fetch` warning on every navigation

The root layout's silent refresh now runs on the `fetch` its `load` is handed, so the dev server stops warning on each navigation ([auth.ts](frontend/src/lib/stores/auth.ts)).
