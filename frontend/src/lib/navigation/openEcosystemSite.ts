import {
  ECOSYSTEM_SITES,
  ecosystemSiteLink,
  type EcosystemSite,
} from '$lib/navigation/ecosystemSites';
import { destIsAllowed } from '$lib/navigation/handoffDest';
import { apiFetch } from '$lib/utils/apiFetch';
import { refusalFromResponse, ApiRefusalError } from '$lib/utils/apiRefusalError';
import { coreUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { isTauriRuntime } from '$lib/utils/tauriRuntime';

/** The page of a site that redeems a handoff token; the token rides in the fragment after it. */
const HANDOFF_LANDING_PATH = '/auth/handoff';

/** The 404 code of an estate that holds no signing key: its configured state, not a failure. */
const HANDOFF_NOT_OFFERED = 'HANDOFF_NOT_OFFERED';

/**
 * The 403 codes of a person MiConnect itself must see first - the current terms, the Alumni link step
 * (D44), or why the Alumni gate of MiGallery / Le Cercle stops them (D42-D43). For that person the
 * site's own MiConnect sign-in IS the primary path, since MiConnect shows them that page: the site is
 * opened THROUGH that sign-in ({@link signInSiteUrl}, owner 2026-11-25), so they see the page once
 * and land signed in where they were going; said at info with what MiConnect will ask, never at warn.
 * The codes are libs/contracts/ecosystem-sites.json's.
 */
export const SETTLED_AT_MICONNECT: Readonly<Record<string, string>> = {
  HANDOFF_TERMS_NOT_ACCEPTED: 'the current MiConnect terms are not accepted yet',
  HANDOFF_ALUMNI_LINK_REQUIRED: 'MiConnect asks to link the Alumni account first',
  HANDOFF_ALUMNI_COTISANT_REQUIRED: 'MiConnect admits Alumni contributors only past the free years',
};

/**
 * The mint answered with a URL that is not on the site asked for - which the server never composes.
 * Typed at the throw, so the open is plain and the line names the defect.
 */
class HandoffUrlMismatchError extends Error {
  constructor(site: EcosystemSite['id']) {
    super(`the handoff URL is not on ${site}'s origin`);
    this.name = 'HandoffUrlMismatchError';
  }
}

/** Said once per app run: an estate without the handoff opens every site plainly by design. */
let notOfferedSaid = false;

/** The plain address of `dest` on `site`: today's behaviour, and what a site without the flag gets. */
export function plainSiteUrl(site: EcosystemSite, dest: string): string {
  return dest === '/' ? site.href : `${site.href}${dest}`;
}

/**
 * The site's own MiConnect sign-in entry, returning to `dest` (libs/contracts/ecosystem-sites.json's
 * `signIn`). The return path is passed only when the site reads one, `dest` is not its home, and
 * `dest` is on the site's allowlist: a path the registry did not vouch for never reaches a sign-in.
 * A site without an entry (none outside MiConnect) gets its plain address.
 */
export function signInSiteUrl(site: EcosystemSite, dest: string): string {
  if (!site.signIn) return plainSiteUrl(site, dest);
  const entry = `${site.href}${site.signIn.path}`;
  const { returnParam } = site.signIn;
  if (!returnParam || dest === '/' || !destIsAllowed(dest, site.dests)) return entry;
  return `${entry}?${returnParam}=${encodeURIComponent(dest)}`;
}

/**
 * Asks core-service for a one-time sign-in handoff towards `site`, landing on `dest`
 * (docs/wiki/sessions.md, "The sign-in handoff"). Resolves with the URL to open: the site's
 * `/auth/handoff`, the token in the FRAGMENT, which no browser sends to a server. The URL is
 * composed by the server from its closed registry; it is still checked to be on the site's origin,
 * because this is the one place a credential is about to leave the app.
 */
async function mintSiteHandoff(site: EcosystemSite, dest: string): Promise<string> {
  Log.d('ecosystemSite.mint', { site: site.id, dest });
  const res = await apiFetch(`${coreUrl()}/api/auth/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aud: site.id, dest }),
  });
  if (!res.ok) throw await refusalFromResponse(res, 'handoff refused');
  const body = (await res.json()) as { url?: unknown };
  const url = typeof body.url === 'string' ? body.url : '';
  if (!url.startsWith(`${site.href}${HANDOFF_LANDING_PATH}#`)) {
    throw new HandoffUrlMismatchError(site.id);
  }
  return url;
}

/**
 * Where a site opens when its handoff is on but no token was minted, and why, said once.
 *
 * A person MiConnect must show a page first ({@link SETTLED_AT_MICONNECT}) opens the site's MiConnect
 * sign-in towards `dest` ({@link signInSiteUrl}): that is their primary path, said at info. Every
 * other refusal opens the site plainly, as before. The PRIMARY PATH FAILED there, so it is said at
 * `warn` with its class (the refusal's code and status, or the error's name) - except an estate that
 * holds no key, whose plain open is its configured state and is said once at info.
 */
function urlWithoutHandoff(site: EcosystemSite, dest: string, err: unknown): string {
  const plain = plainSiteUrl(site, dest);
  if (err instanceof ApiRefusalError && err.status === 404 && err.code === HANDOFF_NOT_OFFERED) {
    if (!notOfferedSaid) {
      notOfferedSaid = true;
      Log.i('ecosystemSite', 'no sign-in handoff on this estate - sites open plainly');
    }
    return plain;
  }
  // MiConnect has a page to show this person first (terms, Alumni link, Alumni gate): EXPECTED for
  // whole cohorts, and opening the site through its sign-in is how they reach that page. One info
  // line per open, never a warn.
  const settled =
    err instanceof ApiRefusalError && err.status === 403 && err.code
      ? SETTLED_AT_MICONNECT[err.code]
      : undefined;
  if (settled) {
    Log.i('ecosystemSite', `${site.id} opens through its MiConnect sign-in: ${settled}`);
    return signInSiteUrl(site, dest);
  }
  const cls =
    err instanceof ApiRefusalError
      ? `${err.code ?? 'uncoded'} (${err.status})`
      : err instanceof Error
        ? err.name
        : 'unknown';
  console.warn(
    `[ecosystemSite] handoff to ${site.id} not minted, class=${cls} - opening it plainly`,
    err
  );
  return plain;
}

/** Opens `url` in the system browser (native shells). A rejected open is logged, never thrown. */
function openInSystemBrowser(url: string, site: EcosystemSite): void {
  void import('@tauri-apps/plugin-opener')
    .then(({ openUrl }) => openUrl(url))
    .catch((e: unknown) =>
      // The class only: the URL may carry a handoff token, and an opener error can quote it.
      console.warn(
        `[ecosystemSite] ${site.id} could not be opened, class=${e instanceof Error ? e.name : typeof e}`
      )
    );
}

/**
 * OPENS A SIBLING SITE FROM ONE OF CANARI'S OWN BUTTONS - the launcher, the profile photo, the
 * profile-photo prompt. THE ONE OPENER: a registered origin is opened nowhere else
 * (`openEcosystemSite.test.ts` fails if one is).
 *
 * A site whose `handoff` flag is on is opened SIGNED IN: a token is minted for this tap
 * ({@link mintSiteHandoff}) and the site redeems it. A site without the flag is opened plainly,
 * which is today's behaviour and not a fallback. A refused or failed mint opens it plainly too, and
 * THAT is a fallback: said at warn with its class ({@link urlWithoutHandoff}) - unless MiConnect has a
 * page to show the person first, which only its own sign-in reaches: the site is then opened through
 * that sign-in, returning to `dest`.
 *
 * Never leaves Canari: the system browser on the native shells; a NEW TAB on the web, opened
 * `about:blank` in the click's own turn - a window opened after an `await` is no longer a user
 * gesture and a popup blocker drops it - then cut from its opener and pointed at the URL once the
 * mint answers (the Adminer pattern, `adminerSession.ts`).
 *
 * A link inside a message or a post reaches it only through {@link openEcosystemSiteLink}, and only
 * for a path of the site's allowlist (owner, 2026-11-25).
 */
export function openEcosystemSite(id: EcosystemSite['id'], dest = '/'): void {
  const site = ECOSYSTEM_SITES.find((s) => s.id === id);
  if (!site) {
    console.warn(`[ecosystemSite] unknown site ${id}`);
    return;
  }
  const plain = plainSiteUrl(site, dest);
  Log.i('ecosystemSite', `opening ${site.id} ${dest} handoff=${site.handoff ? 'on' : 'off'}`);

  if (isTauriRuntime()) {
    if (!site.handoff) {
      openInSystemBrowser(plain, site);
      return;
    }
    void mintSiteHandoff(site, dest)
      .catch((err: unknown) => urlWithoutHandoff(site, dest, err))
      .then((url) => openInSystemBrowser(url, site));
    return;
  }

  if (!site.handoff) {
    window.open(plain, '_blank', 'noopener');
    return;
  }
  const tab = window.open('about:blank', '_blank');
  if (!tab) {
    // No `noopener` on this call, so a null IS a popup blocker: there is no tab to steer, and
    // replacing Canari's own tab would drop its socket and MLS state.
    console.warn(`[ecosystemSite] the tab for ${site.id} was blocked by a popup rule`);
    return;
  }
  // The opener link is cut before the tab is steered: the site must not reach back into Canari.
  tab.opener = null;
  void mintSiteHandoff(site, dest)
    .catch((err: unknown) => urlWithoutHandoff(site, dest, err))
    .then((url) => {
      if (tab.closed) {
        Log.d('ecosystemSite.tabClosed', { site: site.id });
        return;
      }
      tab.location.href = url;
    });
}

/**
 * OPENS A LINK WRITTEN IN A MESSAGE OR A POST THROUGH THE HANDOFF, when it points at a flagged site
 * and a path of its allowlist ({@link ecosystemSiteLink}: exact origin, no query, no fragment, no
 * credentials). Returns false, opening nothing, for any other link, which then opens as any external
 * link does. Called by `openExternal` AFTER its Safe Browsing gate, so that gate runs first for
 * every link (owner, 2026-11-25).
 *
 * Why a link someone else wrote may do this: it cannot choose the site (the origin must be a
 * registered one), the page (only an allowlisted path, each one a page a handoff session can browse
 * and never change anything from - the site's step-up, design note section 3.7), or where the token
 * goes (core-service composes the URL on the site's own landing path, and {@link mintSiteHandoff}
 * refuses any other). The token is minted for the READER's own session, so nobody is signed in as
 * anybody else.
 */
export function openEcosystemSiteLink(href: string): boolean {
  const link = ecosystemSiteLink(href);
  if (!link) {
    Log.d('ecosystemSite.link', { handoff: false });
    return false;
  }
  Log.i(
    'ecosystemSite',
    `a link in content opens ${link.site.id} ${link.dest} through the handoff`
  );
  openEcosystemSite(link.site.id, link.dest);
  return true;
}

/** Test seam: forgets that the not-offered state was said. */
export function resetEcosystemSiteForTests(): void {
  notOfferedSaid = false;
}
