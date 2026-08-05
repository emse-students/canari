import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  androidAppLinkPaths,
  buildAppleAppSiteAssociationJson,
  buildAssetLinksJson,
  parseAndroidSha256Fingerprints,
} from './appSiteAssociation';

const here = dirname(fileURLToPath(import.meta.url));
const TAURI_ROOT = resolve(here, '../../../src-tauri');

describe('parseAndroidSha256Fingerprints', () => {
  it('normalizes colon-separated SHA-256 values', () => {
    const fps = parseAndroidSha256Fingerprints(
      'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
    );
    expect(fps).toHaveLength(1);
    expect(fps[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});

describe('buildAssetLinksJson', () => {
  it('emits package_name fr.emse.canari when fingerprints are set', () => {
    const fp =
      '14:6D:E9:25:C5:FF:45:F0:37:B2:86:FD:FF:F0:BD:6B:93:05:6F:08:8A:FB:69:03:0C:2D:9F:E5:7F:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA';
    const json = JSON.parse(buildAssetLinksJson([fp]));
    expect(json[0].target.package_name).toBe('fr.emse.canari');
  });

  it('declares both handle_all_urls and get_login_creds relations', () => {
    const fp =
      '14:6D:E9:25:C5:FF:45:F0:37:B2:86:FD:FF:F0:BD:6B:93:05:6F:08:8A:FB:69:03:0C:2D:9F:E5:7F:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA';
    const json = JSON.parse(buildAssetLinksJson([fp]));
    expect(json[0].relation).toEqual([
      'delegate_permission/common.handle_all_urls',
      'delegate_permission/common.get_login_creds',
    ]);
  });

  it('returns empty array when no fingerprints (verification pending)', () => {
    expect(JSON.parse(buildAssetLinksJson([]))).toEqual([]);
  });
});

describe('buildAppleAppSiteAssociationJson', () => {
  it('includes appID when team id is set', () => {
    const json = JSON.parse(buildAppleAppSiteAssociationJson('ABCDE12345'));
    expect(json.applinks.details[0].appID).toBe('ABCDE12345.fr.emse.canari');
    expect(json.applinks.details[0].paths).toContain('/posts/*');
  });
});

/**
 * The claim an app makes over an https host lives in THREE places that no compiler
 * compares: this module (served as `apple-app-site-association`), the deep-link
 * config in `tauri.conf.json`, and the intent-filter compiled into the APK.
 *
 * Android drifted from the other two and claimed the whole host, so a web login on
 * a phone with the app installed had its `/auth/callback` redirect captured by the
 * app - the browser never completed the OIDC round trip and the user looped back to
 * the login page. These tests are what make that drift fail in CI instead.
 */
describe('App Link path claim (iOS / Android parity)', () => {
  const deepLink = JSON.parse(readFileSync(resolve(TAURI_ROOT, 'tauri.conf.json'), 'utf8')) as {
    plugins: {
      'deep-link': {
        mobile: { scheme: string[]; host?: string; path?: string[]; pathPrefix?: string[] }[];
      };
    };
  };
  const manifest = readFileSync(
    resolve(TAURI_ROOT, 'gen/android/app/src/main/AndroidManifest.xml'),
    'utf8'
  );

  const webEntry = deepLink.plugins['deep-link'].mobile.find((e) => e.scheme.includes('https'));

  /** The single https intent-filter - the one Android verifies against assetlinks.json. */
  const webFilter = (manifest.match(/<intent-filter[\s\S]*?<\/intent-filter>/g) ?? []).find((f) =>
    f.includes('android:scheme="https"')
  );

  it('tauri.conf.json mirrors the iOS list exactly', () => {
    expect(webEntry, 'no https entry in plugins.deep-link.mobile').toBeDefined();
    const expected = androidAppLinkPaths();
    expect(webEntry?.path ?? []).toEqual(expected.path);
    expect(webEntry?.pathPrefix ?? []).toEqual(expected.pathPrefix);
  });

  it('the generated intent-filter carries every declared path', () => {
    expect(webFilter, 'no https intent-filter in AndroidManifest.xml').toBeDefined();
    const expected = androidAppLinkPaths();
    for (const p of expected.path) {
      expect(webFilter, `android:path="${p}" missing`).toContain(`android:path="${p}"`);
    }
    for (const p of expected.pathPrefix) {
      expect(webFilter, `android:pathPrefix="${p}" missing`).toContain(`android:pathPrefix="${p}"`);
    }
  });

  it('is a restricted claim, never the whole host', () => {
    // A filter with a host but no path element at all matches every URL on that
    // host - which is the regression this whole block exists to catch.
    expect(webFilter).toMatch(/android:path(Prefix|Pattern)?=/);
  });

  it('claims no path the OIDC round trip or the backend needs', () => {
    const forbidden = ['/auth', '/api', '/admin', '/dev', '/internal', '/.well-known'];
    const claimed = [
      ...androidAppLinkPaths().path,
      ...androidAppLinkPaths().pathPrefix,
      // What the served Apple file claims, minus its NOT entries.
      ...(JSON.parse(buildAppleAppSiteAssociationJson('ABCDE12345')).applinks.details[0]
        .paths as string[]),
    ].filter((p) => !p.startsWith('NOT '));

    for (const path of claimed) {
      if (path === '/') continue; // the bare root is an exact match, not a prefix
      for (const bad of forbidden) {
        expect(path.startsWith(bad), `${path} claims ${bad}`).toBe(false);
      }
    }
  });
});
