/**
 * The one definition of the Meta in-app browser gate, tested where it is written (`make
 * test-ci-scripts`). Every adapter is checked against `fixtures.json`: detect.ts, the server gate,
 * the interstitial's own inline script, and the nginx map MiConnect runs (whose live behaviour
 * infrastructure/authentik/test-blueprints.sh drives through a real nginx).
 */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectMetaInAppBrowser,
  exitHref,
  META_IN_APP_BROWSER_RULES,
  type MetaInAppBrowser,
} from './detect';
import {
  APP_LINK_META,
  gatedInAppBrowser,
  interstitialBody,
  interstitialCsp,
  isTopLevelDocument,
  leaveInAppBrowserResponse,
} from './gate';
import { renderGateConf } from './nginx';

interface Case {
  name: string;
  userAgent: string;
  expect: MetaInAppBrowser | null;
}

const here = import.meta.dir;
const { cases } = JSON.parse(readFileSync(join(here, 'fixtures.json'), 'utf8')) as {
  cases: Case[];
};
const html = readFileSync(join(here, 'interstitial.html'), 'utf8');

/**
 * The text between the first `<tag>` and the next `</tag>` of our own interstitial - a plain slice,
 * not a regex: the file is ours and holds each element once (asserted below), and a tag-matching
 * regex is what CodeQL's js/bad-tag-filter flags.
 */
function inner(tag: string): string {
  const open = `<${tag}>`;
  const start = html.indexOf(open);
  const end = html.indexOf(`</${tag}>`, start);
  if (start < 0 || end < 0) throw new Error(`the interstitial holds no <${tag}> element`);
  return html.slice(start + open.length, end);
}
const inApp = cases.filter((c) => c.expect !== null);

/** A request as a browser sends a page navigation, with `overrides` on top. */
function request(userAgent: string, overrides: Record<string, string | null> = {}, method = 'GET') {
  const headers: Record<string, string | null> = {
    'user-agent': userAgent,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'sec-fetch-dest': 'document',
    ...overrides,
  };
  return { method, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
}

describe('detectMetaInAppBrowser', () => {
  for (const c of cases) {
    it(`${c.name} -> ${c.expect ? `${c.expect.app}/${c.expect.os}` : 'let through'}`, () => {
      expect(detectMetaInAppBrowser(c.userAgent)).toEqual(c.expect);
    });
  }

  it('the fixtures cover every app, both systems, an iOS without the Safari scheme, and the crawlers', () => {
    const apps = new Set(inApp.map((c) => c.expect?.app));
    expect([...apps].sort()).toEqual(['facebook', 'instagram', 'messenger', 'threads']);
    expect(inApp.some((c) => c.expect?.os === 'android')).toBe(true);
    expect(inApp.some((c) => (c.expect?.iosMajor ?? 99) < 17)).toBe(true);
    expect(cases.some((c) => c.userAgent.startsWith('facebookexternalhit') && !c.expect)).toBe(
      true
    );
    expect(cases.some((c) => c.userAgent.startsWith('meta-externalagent') && !c.expect)).toBe(true);
  });

  it('every pattern stays in the subset JavaScript and nginx PCRE read identically', () => {
    for (const [, pattern] of META_IN_APP_BROWSER_RULES) {
      expect(pattern).toMatch(/^[A-Za-z0-9_/ |[\]-]+$/);
    }
  });
});

describe('exitHref', () => {
  const href = 'https://canari.emse.fr/posts/abc?x=1&y=%20#comment';

  it('Android: a no-package https VIEW intent, no fallback URL, no fragment', () => {
    const android = detectMetaInAppBrowser(
      inApp.find((c) => c.expect?.os === 'android')!.userAgent
    )!;
    expect(exitHref(android, href)).toBe(
      'intent://canari.emse.fr/posts/abc?x=1&y=%20#Intent;scheme=https;' +
        'action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end'
    );
  });

  it('iOS 17 and later: the same page in Safari; iOS 16: no automatic door', () => {
    expect(exitHref({ app: 'messenger', os: 'ios', iosMajor: 17 }, href)).toBe(`x-safari-${href}`);
    expect(exitHref({ app: 'messenger', os: 'ios', iosMajor: 16 }, href)).toBeNull();
    expect(exitHref({ app: 'messenger', os: 'ios', iosMajor: null }, href)).toBeNull();
    expect(exitHref({ app: 'facebook', os: 'other', iosMajor: null }, href)).toBeNull();
  });

  it("the interstitial's own script computes the same door as detect.ts, for every in-app case", () => {
    const script = inner('script');
    // `document` undefined: the script defines exitFor and does not run its page half.
    const exitFor = new Function('document', `${script}\nreturn exitFor;`)(undefined) as (
      ua: string,
      href: string
    ) => { os: string; href: string | null };
    const hrefs = [
      href,
      'https://miconnect.emse.fr/if/flow/enrol/?itoken=a%2Fb',
      'http://localhost:5173/',
      'https://sky.emse.fr/',
    ];
    for (const c of inApp) {
      for (const page of hrefs) {
        const browser = detectMetaInAppBrowser(c.userAgent)!;
        expect({ case: c.name, ...exitFor(c.userAgent, page) }).toEqual({
          case: c.name,
          os: browser.os,
          href: exitHref(browser, page),
        });
      }
    }
  });
});

describe('the gate', () => {
  const messenger = inApp[0].userAgent;
  const crawler = cases.find((c) => c.userAgent.startsWith('facebookexternalhit'))!.userAgent;

  it('a page request from an in-app browser is gated, by Sec-Fetch-Dest or else by Accept', () => {
    expect(gatedInAppBrowser(request(messenger), '/posts/abc')?.app).toBe('messenger');
    expect(gatedInAppBrowser(request(messenger), '/')?.app).toBe('messenger');
    expect(gatedInAppBrowser(request(messenger, { 'sec-fetch-dest': null }), '/x')).not.toBeNull();
    expect(gatedInAppBrowser(request(messenger, {}, 'HEAD'), '/x')).not.toBeNull();
  });

  it('never an API call, an asset, an association file, a fetch, a frame or a POST', () => {
    for (const path of [
      '/api/users/me',
      '/_app/immutable/x.js',
      '/.well-known/assetlinks.json',
      '/outpost.goauthentik.io/auth/nginx',
    ]) {
      expect(gatedInAppBrowser(request(messenger), path)).toBeNull();
    }
    for (const dest of ['empty', 'image', 'script', 'style', 'iframe', 'manifest']) {
      expect(gatedInAppBrowser(request(messenger, { 'sec-fetch-dest': dest }), '/x')).toBeNull();
    }
    expect(
      gatedInAppBrowser(request(messenger, { 'sec-fetch-dest': null, accept: 'image/*' }), '/a.png')
    ).toBeNull();
    expect(
      gatedInAppBrowser(request(messenger, { 'sec-fetch-dest': null, accept: '*/*' }), '/x')
    ).toBeNull();
    expect(gatedInAppBrowser(request(messenger, {}, 'POST'), '/x')).toBeNull();
    expect(isTopLevelDocument(request(messenger, {}, 'OPTIONS'))).toBe(false);
  });

  it("never a crawler or a real browser - the link preview card keeps the page's head", () => {
    for (const c of cases.filter((x) => !x.expect)) {
      expect(gatedInAppBrowser(request(c.userAgent), '/posts/abc')).toBeNull();
    }
    expect(gatedInAppBrowser(request(crawler, { 'sec-fetch-dest': null }), '/')).toBeNull();
  });

  it('answers 200 with the page, no-store, Vary: User-Agent, noindex and its own CSP', async () => {
    const lines: string[] = [];
    const url = new URL('https://canari.emse.fr/posts/abc?secret=1');
    const response = leaveInAppBrowserResponse(request(messenger), url, {
      html,
      site: 'canari',
      log: (line) => lines.push(line),
    })!;
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('User-Agent');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(interstitialCsp(html));
    expect(await response.text()).toBe(html);
    // One line, naming the route's first segment and never the query.
    expect(lines).toEqual([
      '[leave-iab] interstitial served site=canari app=messenger os=ios ios=18 route=/posts',
    ]);
    expect(lines[0]).not.toContain('secret');
  });

  it('HEAD gets the headers and no body; a let-through request gets null', async () => {
    const url = new URL('https://canari.emse.fr/');
    const options = { html, site: 'canari', log: () => {} };
    const head = leaveInAppBrowserResponse(request(messenger, {}, 'HEAD'), url, options)!;
    expect(await head.text()).toBe('');
    expect(leaveInAppBrowserResponse(request(crawler), url, options)).toBeNull();
  });

  it("writes the app's own link into its marker, escaped, and nothing else changes", () => {
    const link = 'fr.emse.canari://open?url=https%3A%2F%2Fcanari.emse.fr%2Fposts%2Fa&x="<>';
    const body = interstitialBody(html, link);
    expect(body).toContain(
      '<meta name="leave-iab-app" content="fr.emse.canari://open?url=https%3A%2F%2Fcanari.emse.fr%2Fposts%2Fa&amp;x=&quot;&lt;&gt;" />'
    );
    expect(body.replace(/<meta name="leave-iab-app"[^>]*>/, APP_LINK_META)).toBe(html);
    expect(interstitialBody(html, null)).toBe(html);
  });
});

describe('the interstitial', () => {
  it('holds one script and one style, both hashed into its CSP, and the app link marker once', () => {
    const script = inner('script');
    const style = inner('style');
    const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64');
    expect(interstitialCsp(html)).toBe(
      `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; ` +
        "img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    );
    expect(html.split(APP_LINK_META).length).toBe(2);
  });

  it('loads nothing from anywhere and carries no inline handler or style attribute', () => {
    expect(html).not.toMatch(/\ssrc=/);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/url\(/);
    expect(html).not.toMatch(/\son[a-z]+=/);
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('speaks French by default and English when asked, with the manual way out in both', () => {
    expect(html).toMatch(/<html lang="fr">/);
    expect(html).toContain('<div lang="en" data-lang="en" hidden>');
    expect(html).toContain('&quot;Ouvrir dans Safari&quot;');
    expect(html).toContain('&quot;Open in Safari&quot;');
    expect(html).toContain('Copier le lien');
    expect(html).toContain('Copy the link');
  });

  it('tells a reader without JavaScript where the address is, in both languages', () => {
    const noscripts = [...html.matchAll(/<noscript\s*>([\s\S]*?)<\/noscript/g)].map((m) => m[1]);
    expect(noscripts).toHaveLength(2);
    expect(noscripts[0]).toContain("barre d'adresse");
    expect(noscripts[1]).toContain('address bar');
  });
});

describe('the nginx gate', () => {
  const conf = renderGateConf(html);

  it("maps the user agent by detect.ts's rules, in their order", () => {
    const lines = [...conf.matchAll(/^ {8}"~([^"]+)" (messenger|instagram|threads|facebook);$/gm)];
    expect(lines.map((l) => [l[2], l[1]])).toEqual(
      META_IN_APP_BROWSER_RULES.map(([app, pattern]) => [app, pattern])
    );
  });

  it("serves the interstitial with gate.ts's CSP and headers, and passes the rest to authentik", () => {
    expect(conf).toContain(`add_header Content-Security-Policy "${interstitialCsp(html)}" always;`);
    expect(conf).toContain('add_header Cache-Control "no-store" always;');
    expect(conf).toContain('add_header Vary "User-Agent" always;');
    expect(conf).toContain('"~^/api/" 1;');
    expect(conf).toContain('"~^/_app/" 1;');
    expect(conf).toContain('"~^/\\.well-known/" 1;');
    expect(conf).toContain('"~^/outpost\\.goauthentik\\.io/" 1;');
    expect(conf).toContain('proxy_pass http://$leave_iab_upstream;');
    expect(conf).toContain('resolver 127.0.0.11');
  });
});
