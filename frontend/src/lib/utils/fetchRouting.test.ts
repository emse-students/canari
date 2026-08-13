import { fetchInputUrl, shouldUseNativeFetch } from './fetchRouting';

describe('shouldUseNativeFetch', () => {
  it('keeps a blob: URL native - the defect that broke every download on mobile', () => {
    // The HTTP plugin is a network client and rejects it with `scheme blob not supported`, which
    // arrives as a bare rejected promise. Saving a decrypted attachment reads its object URL back,
    // so this one omission made eleven download buttons fail on Android and iOS (WP-DL-1).
    expect(shouldUseNativeFetch('blob:http://tauri.localhost/2f0c-...')).toBe(true);
  });

  it.each([
    ['data:', 'data:application/pdf;base64,JVBERi0='],
    ['filesystem:', 'filesystem:http://tauri.localhost/temporary/x'],
    ['a relative path', '/api/posts'],
    ['a protocol-relative path', './chunk.js'],
  ])('keeps %s native - the WebView is the only thing that can resolve it', (_label, url) => {
    expect(shouldUseNativeFetch(url)).toBe(true);
  });

  it('sends an ordinary https request to the plugin, which is the whole point of the override', () => {
    expect(shouldUseNativeFetch('https://canari-emse.fr/api/version')).toBe(false);
  });

  it.each([
    ["Tauri's IPC bridge", 'http://ipc.localhost/plugin%3A__TAURI_CHANNEL__%7Cfetch'],
    ["the app's own assets", 'http://tauri.localhost/_app/immutable/chunk.js'],
    ['a converted file source', 'http://asset.localhost/var/data/x.png'],
    ['the https form Windows and Android can be configured to use', 'https://ipc.localhost/x'],
    ['a scheme registered by some future plugin', 'http://whatever.localhost/x'],
  ])('keeps %s native - it is a custom protocol, not a network host', (_label, url) => {
    // Routing `ipc.localhost` to the network client is what made Tauri give up on its custom
    // protocol and fall back to `postMessage` for the whole session, on every Android cold start.
    expect(shouldUseNativeFetch(url)).toBe(true);
  });

  it('does not mistake a real host that merely ENDS in localhost for a custom protocol', () => {
    expect(shouldUseNativeFetch('https://notlocalhost/api/x')).toBe(false);
    expect(shouldUseNativeFetch('https://evil-localhost.example/api/x')).toBe(false);
  });

  it('keeps a cookie-bearing request native, whose jar the plugin cannot write back', () => {
    expect(
      shouldUseNativeFetch('https://canari-emse.fr/api/auth/refresh', { credentials: 'include' })
    ).toBe(true);
  });

  it.each([
    'http://127.0.0.1:1420/src/main.ts',
    'http://localhost:1420/@vite/client',
    'https://canari-emse.fr/posts/__data.json',
  ])('keeps the dev server and SvelteKit data requests native (%s)', (url) => {
    expect(shouldUseNativeFetch(url)).toBe(true);
  });

  it('treats a missing URL as native rather than guessing', () => {
    expect(shouldUseNativeFetch(null)).toBe(true);
    expect(shouldUseNativeFetch(undefined)).toBe(true);
    expect(shouldUseNativeFetch('')).toBe(true);
  });
});

describe('fetchInputUrl', () => {
  it('reads the three shapes fetch accepts', () => {
    expect(fetchInputUrl('https://a.test/x')).toBe('https://a.test/x');
    expect(fetchInputUrl(new URL('https://a.test/y'))).toBe('https://a.test/y');
    expect(fetchInputUrl(new Request('https://a.test/z'))).toBe('https://a.test/z');
  });
});
