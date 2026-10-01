/**
 * WHICH ORIGIN EMITTED A CONSOLE LINE - so the browser report can call a foreign one foreign.
 *
 * `login.mjs` drives the real login, so the observed TAB navigates to the identity provider and
 * back, and a console observer follows the tab, not the origin: everything Authentik's front end
 * printed landed in `unexplained`, attributed to Canari, and every row that logs in collected it
 * (HEAL-REVOKE-9: ten lines). `IDP_CONSOLE_NARRATION` is a per-row disposition; this is the fact it
 * stands in for. The phone report already buckets other applications as `foreign`.
 *
 * PURE, so a self-test pins it with no browser. Attribution order, most to least trustworthy:
 * the execution context's own origin (`Runtime.executionContextCreated`), then the top stack
 * frame's url, then - for `Log.entryAdded`, and ONLY when its source is not `network` - its url. A
 * network entry's url names the RESOURCE, which may legitimately live elsewhere (a CDN blocked by
 * CSP is our defect, not a foreign console), so it is never an emitter.
 *
 * NEVER FORGIVES WHAT IT CANNOT ATTRIBUTE: no origin -> not foreign; no `home` set -> nothing is
 * foreign. The report counts and names the foreign origins, so the removal is reported, not silent.
 */

/** The origins a Tauri WebView serves the app from. */
export const TAURI_ORIGINS = ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'];

/** `scheme://host[:port]` of a url, or null when it is not an absolute http(s)/tauri url. */
export function originOfUrl(url) {
  if (typeof url !== 'string') return null;
  const m = /^(https?:\/\/[^/?#]+|tauri:\/\/[^/?#]+)/.exec(url);
  return m ? m[1] : null;
}

/** executionContextId -> origin, from the `Runtime.executionContextCreated` events of a window. */
export function contextOrigins(events) {
  const out = new Map();
  for (const e of events) {
    if (e.method === 'Runtime.executionContextCreated' && e.params?.context) {
      const o = e.params.context.origin;
      if (typeof o === 'string' && o !== '' && o !== 'null') out.set(e.params.context.id, o);
    }
  }
  return out;
}

/**
 * The origin that emitted one console event, or null when none can be shown.
 *
 * @param {{method: string, params: object}} e a `Runtime.consoleAPICalled` or `Log.entryAdded` event
 * @param {Map<number, string>} ctx from {@link contextOrigins}
 */
export function originOfConsoleEvent(e, ctx) {
  const p = e.params;
  if (e.method === 'Runtime.consoleAPICalled') {
    return ctx.get(p.executionContextId) ?? originOfUrl(p.stackTrace?.callFrames?.[0]?.url);
  }
  if (e.method === 'Log.entryAdded') {
    return p.entry?.source === 'network' ? null : originOfUrl(p.entry?.url);
  }
  return null;
}

/**
 * Whether `origin` is somebody else's: attributable, and not one of the `home` origins.
 *
 * @param {string|null} origin
 * @param {Set<string>|string[]} home the application's own origins; empty means "do not attribute"
 */
export function isForeignOrigin(origin, home) {
  const set = home instanceof Set ? home : new Set(home);
  if (!origin || set.size === 0) return false;
  return !set.has(origin);
}
