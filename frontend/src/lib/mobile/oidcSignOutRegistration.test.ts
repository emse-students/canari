import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OIDC_MOBILE_POST_LOGOUT_URI, OIDC_SIGNED_OUT_HOST } from './appSiteAssociation';

/**
 * THE MICONNECT HALF OF CANARI'S SIGN-OUT, AS THE BLUEPRINTS DESCRIBE IT.
 *
 * The client sends every sign-out to end-session with a `post_logout_redirect_uri`
 * (`leaveSignedOut` in `stores/auth.ts`). Authentik answers `invalid_post_logout_redirect_uri` -
 * a bare error page, inside the Custom Tab on a phone - for any address the provider does not list
 * as a `logout` redirect URI, and the session survives unless the provider's invalidation flow
 * actually logs the user out (`default-provider-invalidation-flow` is stageless). Nothing on the
 * client can see either fact, so they are asserted where they are written.
 */
const blueprints = resolve(__dirname, '../../../../infrastructure/authentik/blueprints');
const providers = readFileSync(resolve(blueprints, '50-providers.yaml'), 'utf8');
const authentication = readFileSync(resolve(blueprints, '40-authentication.yaml'), 'utf8');

/** The text of the provider entry that DESCRIBES `name` (not a rename entry naming it). */
function providerEntry(name: string): string {
  const entries = providers.split('\n  - model: ');
  const entry = entries.find((e) =>
    e.startsWith(
      `authentik_providers_oauth2.oauth2provider\n    identifiers:\n      name: "${name}"\n`
    )
  );
  expect(entry, `no entry describes ${name}`).toBeDefined();
  return entry!;
}

/** The redirect URIs of `entry` registered with the given type. */
function redirectUris(entry: string, type: 'authorization' | 'logout'): string[] {
  return [...entry.matchAll(/url: "([^"]+)"\n\s+redirect_uri_type: "([a-z]+)"/g)]
    .filter((m) => m[2] === type)
    .map((m) => m[1]!);
}

describe.each(['miconnect-canari', 'miconnect-canari-dev', 'miconnect-canari-local'])(
  'the %s provider',
  (name) => {
    const entry = providerEntry(name);

    it('runs the invalidation flow that ends the MiConnect session', () => {
      expect(entry).toContain(
        'invalidation_flow: !Find [authentik_flows.flow, [slug, "miconnect-invalidation-signout"]]'
      );
    });

    it("lets a phone app come back on the app's own scheme", () => {
      expect(OIDC_MOBILE_POST_LOGOUT_URI).toBe(`fr.emse.canari://${OIDC_SIGNED_OUT_HOST}`);
      expect(redirectUris(entry, 'logout')).toContain(OIDC_MOBILE_POST_LOGOUT_URI);
    });

    it('lets every web origin it signs in come back to its /login', () => {
      const logout = redirectUris(entry, 'logout');
      for (const callback of redirectUris(entry, 'authorization')) {
        if (!callback.endsWith('/auth/callback')) continue;
        expect(logout).toContain(callback.replace(/\/auth\/callback$/, '/login'));
      }
    });
  }
);

describe('the sign-out invalidation flow', () => {
  it('binds the stage that logs the user out of MiConnect', () => {
    expect(authentication).toMatch(
      /target: !Find \[authentik_flows\.flow, \[slug, "miconnect-invalidation-signout"\]\]\n\s+stage: !Find \[authentik_stages_user_logout\.userlogoutstage, \[name, "default-invalidation-logout"\]\]/
    );
  });
});
