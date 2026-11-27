/**
 * THE WEB POLICY'S DIRECTIVES, importing only another import-free module, so the BROWSER bundle can
 * read them too.
 *
 * `cspPolicy.js` builds the policy (and needs `node:crypto` and an HTML parser to hash the inline
 * scripts), so the app cannot import it; `connectAllowlist.ts` must still read the `connect-src` the
 * web page is held to, from the one list that states it. Why each source is here is written in
 * `cspPolicy.js`'s header, next to the code that serialises it.
 */

import { MAIL_FRAME_SCRIPT_HASH } from './mailFrameScript.js';

/** @typedef {Record<string, string[]>} CspDirectives */

/**
 * The directives every web response carries, page or not, before any per-page hash is added.
 *
 * @type {Readonly<CspDirectives>}
 */
export const WEB_POLICY_DIRECTIVES = Object.freeze({
  'default-src': ['self'],
  // The HTML mail frame's one script (`mailFrameScript.js`): a `srcdoc` frame inherits this policy.
  'script-src': ['self', 'wasm-unsafe-eval', MAIL_FRAME_SCRIPT_HASH],
  'style-src': ['self', 'unsafe-inline'],
  'connect-src': [
    'self',
    'blob:',
    'wss://canari.emse.fr',
    'wss://canari-emse.fr',
    'wss://www.canari-emse.fr',
    'wss://dev.canari-emse.fr',
    'https://static.klipy.com',
  ],
  'img-src': ['self', 'data:', 'blob:', 'https:'],
  'font-src': ['self', 'data:'],
  'worker-src': ['self', 'blob:'],
  'media-src': ['self', 'blob:'],
  'frame-src': ['self'],
  'form-action': ['self'],
  'object-src': ['none'],
  'frame-ancestors': ['none'],
  'base-uri': ['self'],
});
