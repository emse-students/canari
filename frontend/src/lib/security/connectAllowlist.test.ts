import { describe, expect, it } from 'vitest';
import {
  connectAllows,
  enforcedConnectSources,
  isUnderstoodConnectSource,
} from './connectAllowlist';

const WEB_PAGE = 'https://canari-emse.fr';
const APP_PAGE = 'http://tauri.localhost';

describe('connectAllowlist - the connect-src a drop is checked against', () => {
  it('reads every source of BOTH enforced lists in a shape it understands', () => {
    for (const tauri of [false, true]) {
      const sources = enforcedConnectSources(tauri);
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) expect(isUnderstoodConnectSource(source), source).toBe(true);
    }
  });

  it('allows the web page its own origin and the hosts its policy names, nothing else', () => {
    const web = enforcedConnectSources(false);
    expect(connectAllows(`${WEB_PAGE}/api/media/x.png`, web, WEB_PAGE)).toBe(true);
    expect(connectAllows('https://static.klipy.com/a.gif', web, WEB_PAGE)).toBe(true);
    expect(connectAllows('https://other.example/cat.png', web, WEB_PAGE)).toBe(false);
    expect(connectAllows('https://canari.emse.fr/cat.png', web, WEB_PAGE)).toBe(false);
  });

  it("allows the app the estate's https origins and refuses a third-party host", () => {
    const app = enforcedConnectSources(true);
    for (const host of ['canari.emse.fr', 'canari-emse.fr', 'dev.canari-emse.fr']) {
      expect(connectAllows(`https://${host}/cat.png`, app, APP_PAGE), host).toBe(true);
    }
    expect(connectAllows('https://other.example/cat.png', app, APP_PAGE)).toBe(false);
    expect(connectAllows('https://static.klipy.com/a.gif', app, APP_PAGE)).toBe(false);
  });

  it('matches whole origins: a look-alike host, another port or an unparsable address is refused', () => {
    const sources = ['https://canari-emse.fr'];
    expect(connectAllows('https://canari-emse.fr.other.example/x', sources, APP_PAGE)).toBe(false);
    expect(connectAllows('https://canari-emse.fr:8443/x', sources, APP_PAGE)).toBe(false);
    expect(connectAllows('not an address', sources, APP_PAGE)).toBe(false);
  });

  it('reads a scheme source and the http-to-https upgrade as CSP Level 3 does', () => {
    expect(connectAllows('https://any.example/x', ['http:'], APP_PAGE)).toBe(true);
    expect(connectAllows('http://any.example/x', ['https:'], APP_PAGE)).toBe(false);
    expect(connectAllows('https://ipc.localhost/x', ['http://ipc.localhost'], APP_PAGE)).toBe(true);
  });
});
