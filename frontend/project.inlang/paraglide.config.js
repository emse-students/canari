// THE ONE SET OF PARAGLIDE COMPILER OPTIONS. Both writers of `src/lib/paraglide` read this file: the
// CLI (`bun run paraglide:compile`, run by check, test, generate, prepare and the pre-commit hook)
// and the vite plugin in `vite.config.js`. Two sets of options meant two different outputs, and each
// CLI compile invalidated the plugin's cache, so the next `vite dev` rewrote ~4,500 files before it
// listened (222 s). See docs/wiki/frontend/i18n.md. Add an option HERE, never as a flag or a plugin
// argument next to the call.
//
// `outputStructure` is read by the plugin only: the CLI forces `message-modules` itself, which is
// the same value, and `paraglideOptions.test.ts` fails if the two ever differ.
export default {
  // SPA (ssr = false): localStorage, then the browser's language, then the base locale (fr).
  strategy: ['localStorage', 'preferredLanguage', 'baseLocale'],
  // The vite plugin's own value, which wins over the CLI default `typeof window === 'undefined'`.
  isServer: "import.meta.env?.SSR ?? typeof window === 'undefined'",
  // One module per message keeps the production bundle tree-shaken, and in dev the 4,500 files are
  // only written once, by whichever writer runs first.
  outputStructure: 'message-modules',
};
