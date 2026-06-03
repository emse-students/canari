import { describe, expect, it } from 'vitest';
import {
  buildAppleAppSiteAssociationJson,
  buildAssetLinksJson,
  parseAndroidSha256Fingerprints,
} from './appSiteAssociation';

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
