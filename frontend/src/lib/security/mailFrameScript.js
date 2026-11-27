/**
 * THE ONE SCRIPT AN HTML MAIL'S FRAME RUNS (D9, docs/wiki/mail-client-transport.md), and its hash.
 *
 * The mail's frame is an OPAQUE origin (`sandbox="allow-scripts"`, never `allow-same-origin`): the
 * app cannot read its document, so the frame says two things itself, by `postMessage` to its parent:
 *  - `{ type: 'mail-frame-height', h }` - its CONTENT's height, whenever it changes, so the reader
 *    is one scroll and never a box scrolling inside a page. Measured at a zero-height marker kept
 *    last in the body (plus the body's bottom padding, border and margin), NEVER from the html or
 *    body boxes: those follow the frame's own height (`html,body{height:100%}`), and a mail adding
 *    `padding-bottom:1px` made a box measure grow the frame one pixel a round up to the cap (second
 *    review, I-1). The marker's place depends on the content only. Measured on load, on every
 *    image or other resource loading (a capturing `load` listener: a body of fixed height does not
 *    resize when its content grows), and on a resize of the root or body (the width changing);
 *  - `{ type: 'mail-frame-link', href }` - the link the reader pressed (Enter held down repeats
 *    nothing: `ev.repeat` is ignored). The cleaning pass made every
 *    link inert (`data-mail-href`, no `href`), so nothing in the frame navigates; the parent routes
 *    the address through the app's ONE link path (`openExternal`, Safe Browsing gate included).
 *
 * ONLY THIS SCRIPT RUNS: every script of the mail is removed by the cleaning pass, and the frame's
 * policy allows `script-src` by THIS text's hash and nothing else - a script revived past the pass
 * is refused. A `srcdoc` frame also inherits its parent's policy, so the hash is in the web page's
 * (`cspDirectives.js`, held equal to nginx's by `csp.test.ts`) and the native WebView's
 * (`tauri.conf.json`); `mailFrameScript.test.ts` holds all of them to the hash of this text.
 *
 * Plain JavaScript with no import, like `cspDirectives.js`: `kit.config.js` and the browser bundle
 * both read it. THE TEXT IS HASHED BYTE FOR BYTE: any edit changes the hash, and the test names the
 * new one to write in the three places.
 */

/** The script's exact text, as the frame's `<script>` element holds it. */
export const MAIL_FRAME_SCRIPT =
  "(function(){var last=-1,probe=null;function post(m){parent.postMessage(m,'*')}" +
  "var KEEP=[['display','block'],['height','0'],['min-height','0'],['margin','0'],['padding','0']," +
  "['border','0'],['clear','both'],['float','none'],['position','static']];" +
  'function marker(){var b=document.body;if(!b)return null;' +
  "if(!probe){probe=document.createElement('div');" +
  "for(var i=0;i<KEEP.length;i++)probe.style.setProperty(KEEP[i][0],KEEP[i][1],'important')}" +
  'if(b.lastElementChild!==probe)b.appendChild(probe);return probe}' +
  'function measure(){var p=marker();if(!p)return;var cs=getComputedStyle(document.body);' +
  'var h=Math.ceil(p.getBoundingClientRect().top+window.scrollY+(parseFloat(cs.paddingBottom)||0)' +
  '+(parseFloat(cs.borderBottomWidth)||0)+(parseFloat(cs.marginBottom)||0));' +
  "if(h!==last){last=h;post({type:'mail-frame-height',h:h})}}" +
  "function linkOf(t){var e=t&&t.closest?t.closest('[data-mail-href]'):null;" +
  "return e?e.getAttribute('data-mail-href'):null}" +
  'function open(ev){var href=linkOf(ev.target);if(href===null)return;' +
  "ev.preventDefault();post({type:'mail-frame-link',href:href})}" +
  "document.addEventListener('click',open);" +
  "document.addEventListener('keydown',function(ev){if(ev.key==='Enter'&&!ev.repeat)open(ev)});" +
  "window.addEventListener('load',measure);document.addEventListener('load',measure,true);" +
  "if(typeof ResizeObserver==='function'){var o=new ResizeObserver(measure);" +
  'o.observe(document.documentElement);if(document.body)o.observe(document.body)}' +
  'measure()})();';

/** `sha256-<base64>` of {@link MAIL_FRAME_SCRIPT}, unquoted, as `kit.csp` takes a source. */
export const MAIL_FRAME_SCRIPT_HASH = 'sha256-5F0TKgMuuNjwe0z3swA3ySBYTfdWm7wXi3IYTmwOjKA=';
