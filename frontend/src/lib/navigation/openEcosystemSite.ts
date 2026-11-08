import { ECOSYSTEM_SITES, type EcosystemSite } from '$lib/navigation/ecosystemSites';
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
 * The mint answered with a URL that is not on the site asked for - which the server never composes.
 * Typed at the throw, so the open is plain and the line names the defect.
 */
export class HandoffUrlMismatchError extends Error {
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
 * Asks core-service for a one-time sign-in handoff towards `site`, landing on `dest`
 * (docs/wiki/sessions.md, "The sign-in handoff"). Resolves with the URL to open: the site's
 * `/auth/handoff`, the token in the FRAGMENT, which no browser sends to a server. The URL is
 * composed by the server from its closed registry; it is still checked to be on the site's origin,
 * because this is the one place a credential is about to leave the app.
 */
export async function mintSiteHandoff(site: EcosystemSite, dest: string): Promise<string> {
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
 * Says why a site opens plainly although its handoff is on. The PRIMARY PATH FAILED, so it is said
 * at `warn` with its class (the refusal's code and status, or the error's name) - except an estate
 * that holds no key, whose plain open is its configured state and is said once at info.
 */
function reportPlainOpen(site: EcosystemSite, err: unknown): void {
  if (err instanceof ApiRefusalError && err.status === 404 && err.code === HANDOFF_NOT_OFFERED) {
    if (!notOfferedSaid) {
      notOfferedSaid = true;
      Log.i('ecosystemSite', 'no sign-in handoff on this estate - sites open plainly');
    }
    return;
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
}

/** Opens `url` in the system browser (native shells). A rejected open is logged, never thrown. */
function openInSystemBrowser(url: string, site: EcosystemSite): void {
  void import('@tauri-apps/plugin-opener')
    .then(({ openUrl }) => openUrl(url))
    .catch((e) => console.warn(`[ecosystemSite] ${site.id} could not be opened`, e));
}

/**
 * OPENS A SIBLING SITE FROM ONE OF CANARI'S OWN BUTTONS - the launcher, the profile photo, the
 * profile-photo prompt. THE ONE OPENER: a registered origin is opened nowhere else
 * (`openEcosystemSite.test.ts` fails if one is).
 *
 * A site whose `handoff` flag is on is opened SIGNED IN: a token is minted for this tap
 * ({@link mintSiteHandoff}) and the site redeems it. A site without the flag is opened plainly,
 * which is today's behaviour and not a fallback. A refused or failed mint opens it plainly too, and
 * THAT is a fallback: said at warn with its class ({@link reportPlainOpen}).
 *
 * Never leaves Canari: the system browser on the native shells; a NEW TAB on the web, opened
 * `about:blank` in the click's own turn - a window opened after an `await` is no longer a user
 * gesture and a popup blocker drops it - then cut from its opener and pointed at the URL once the
 * mint answers (the Adminer pattern, `adminerSession.ts`).
 *
 * Never for a link inside a message or a post: a link someone else wrote must not choose what the
 * user's own session opens (the design note, section 3.7).
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
      .catch((err: unknown) => {
        reportPlainOpen(site, err);
        return plain;
      })
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
    .catch((err: unknown) => {
      reportPlainOpen(site, err);
      return plain;
    })
    .then((url) => {
      if (tab.closed) {
        Log.d('ecosystemSite.tabClosed', { site: site.id });
        return;
      }
      tab.location.href = url;
    });
}

/** Test seam: forgets that the not-offered state was said. */
export function resetEcosystemSiteForTests(): void {
  notOfferedSaid = false;
}
