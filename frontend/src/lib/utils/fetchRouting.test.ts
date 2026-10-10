import {
  createRoutedFetch,
  fetchInputUrl,
  hasBinaryBody,
  shouldUseNativeFetch,
} from './fetchRouting';

describe('createRoutedFetch - the function hooks.client.ts installs as window.fetch', () => {
  const API = 'https://canari.emse.fr';
  const upload = `${API}/api/media/upload`;
  function rig(origins: () => string[] = () => [API]) {
    const native = vi.fn(async () => new Response('n'));
    const plugin = vi.fn(async () => new Response('p'));
    return { native, plugin, f: createRoutedFetch(native as never, plugin as never, origins) };
  }

  it('sends a binary body to a first-party origin to the WebView, with its arguments intact', async () => {
    const { native, plugin, f } = rig();
    const body = new Blob([new Uint8Array(4)]);
    await f(upload, { method: 'POST', body });
    expect(native).toHaveBeenCalledWith(upload, { method: 'POST', body });
    expect(plugin).not.toHaveBeenCalled();
  });

  it('sends a JSON call to the plugin', async () => {
    const { native, plugin, f } = rig();
    await f(`${API}/api/x`, { method: 'POST', body: '{}' });
    expect(plugin).toHaveBeenCalledTimes(1);
    expect(native).not.toHaveBeenCalled();
  });

  it('passes the Request itself as the third argument, so its body kind decides', async () => {
    const { native, plugin, f } = rig();
    await f(new Request(upload, { method: 'POST', body: new Blob([new Uint8Array(4)]) }));
    expect(native).toHaveBeenCalledTimes(1);
    await f(
      new Request(upload, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    );
    expect(plugin).toHaveBeenCalledTimes(1);
  });

  it('passes the fourth argument fresh on EVERY call, so a changed origin list is honoured', async () => {
    let origins = [API];
    const { native, plugin, f } = rig(() => origins);
    const body = new Blob([new Uint8Array(4)]);
    await f(upload, { body });
    origins = ['https://other.example'];
    await f(upload, { body });
    expect(native).toHaveBeenCalledTimes(1);
    expect(plugin).toHaveBeenCalledTimes(1);
  });

  it('keeps a blob: URL and a cookie-bearing call native', async () => {
    const { native, f } = rig();
    await f('blob:http://tauri.localhost/x');
    await f(`${API}/api/auth/refresh`, { credentials: 'include' });
    expect(native).toHaveBeenCalledTimes(2);
  });
});

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

describe('a binary body to the Canari API (the upload transport)', () => {
  const API = ['https://canari.emse.fr', 'https://canari-emse.fr'];
  const upload = 'https://canari.emse.fr/api/media/upload';

  it.each([
    ['a FormData', () => new FormData()],
    ['a Blob', () => new Blob([new Uint8Array(4)])],
    ['an ArrayBuffer', () => new ArrayBuffer(4)],
    ['a typed array', () => new Uint8Array(4)],
  ])('keeps %s native - the plugin inflates every byte ~85x in Rust', (_label, make) => {
    expect(shouldUseNativeFetch(upload, { method: 'POST', body: make() }, upload, API)).toBe(true);
  });

  it('keeps a JSON string body on the plugin - a few KB cost nothing', () => {
    expect(shouldUseNativeFetch(upload, { method: 'POST', body: '{"a":1}' }, upload, API)).toBe(
      false
    );
  });

  it('keeps a GET on the plugin, whose response body is streamed in raw binary chunks', () => {
    expect(shouldUseNativeFetch(upload, { method: 'GET' }, upload, API)).toBe(false);
  });

  it('keeps a binary body to a THIRD-PARTY host on the plugin - CORS is not ours to grant there', () => {
    const body = new Blob([new Uint8Array(4)]);
    expect(
      shouldUseNativeFetch('https://third-party.example/upload', { body }, undefined, API)
    ).toBe(false);
  });

  it('matches on the ORIGIN, not on a prefix of the host', () => {
    const body = new Blob([new Uint8Array(4)]);
    expect(
      shouldUseNativeFetch('https://canari.emse.fr.evil.example/x', { body }, undefined, API)
    ).toBe(false);
  });

  it('changes nothing when no first-party origin is given', () => {
    const body = new Blob([new Uint8Array(4)]);
    expect(shouldUseNativeFetch(upload, { body })).toBe(false);
  });

  it('reads the body of a Request given as the first argument', () => {
    const req = new Request(upload, { method: 'POST', body: new Blob([new Uint8Array(4)]) });
    expect(shouldUseNativeFetch(upload, undefined, req, API)).toBe(true);
    expect(hasBinaryBody(new Request(upload))).toBe(false);
  });

  it('keeps a JSON Request on the plugin - its body is a stream, but its type says text', () => {
    const req = new Request(upload, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(hasBinaryBody(req)).toBe(false);
    expect(shouldUseNativeFetch(upload, undefined, req, API)).toBe(false);
  });

  it('keeps a string-bodied Request (text/plain) and a urlencoded one on the plugin', () => {
    expect(hasBinaryBody(new Request(upload, { method: 'POST', body: 'hello' }))).toBe(false);
    expect(
      hasBinaryBody(new Request(upload, { method: 'POST', body: new URLSearchParams({ a: '1' }) }))
    ).toBe(false);
  });

  it('keeps a FormData Request and an octet-stream Request native', () => {
    const form = new FormData();
    form.append('a', new Blob([new Uint8Array(4)]), 'a.bin');
    expect(hasBinaryBody(new Request(upload, { method: 'POST', body: form }))).toBe(true);
    expect(
      hasBinaryBody(
        new Request(upload, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(4),
        })
      )
    ).toBe(true);
  });

  it('never sends a ReadableStream body native - WKWebView cannot stream a request body', () => {
    const stream = new ReadableStream({ start: (c) => c.close() });
    expect(hasBinaryBody(upload, { method: 'POST', body: stream })).toBe(false);
    expect(shouldUseNativeFetch(upload, { method: 'POST', body: stream }, upload, API)).toBe(false);
  });

  it('never sends an async-iterable body native', () => {
    const iterable = {
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array(1);
      },
    };
    expect(hasBinaryBody(upload, { method: 'POST', body: iterable as never })).toBe(false);
  });

  it('does not call a form-urlencoded body binary', () => {
    expect(hasBinaryBody(upload, { body: new URLSearchParams({ a: '1' }) })).toBe(false);
    expect(hasBinaryBody(upload, { body: null })).toBe(false);
  });
});
