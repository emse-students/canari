// THE G8 CHAT-LOAD INSTRUMENT (2026-11-17) - evaluated in a page of the web app over CDP
// (`inject.mjs <port>:<substr> eval "$(cat chatload.js)"` after setting `window.__CL_CFG`).
//
// G8 of live-production.md: the chat shares the live's ROW LOCK with the segment ingest, and nothing
// measured that contention. Two roles, results in `window.__CL`:
//
// - `probe` (the BROADCASTER's page, before "Demarrer le live"): wraps the page's `fetch` and times
//   every `PUT /api/lives/:id/segments/:i` the app's own uploader sends - status, refusal code, ms.
// - `chat` (a VIEWER's page, the live open in the app): captures the page's own Authorization header
//   (no credential leaves the page), reads the live key, then seals and posts chat lines at
//   `msgEveryMs` and reaction bursts at `burstEveryMs`, as the format v1 of `liveChatCrypto.ts`
//   (so every other viewer OPENS them - no dropped-line noise), recording each answer.
//
// A throwaway bench like `bench.js`, not product code. `__CL.summary()` returns the counts and the
// latency percentiles; `__CL.stop()` stops the senders.
(() => {
  const C = window.__CL_CFG;
  if (window.__CL && window.__CL.stop) window.__CL.stop();
  const CL = (window.__CL = { role: C.role, rows: [], errors: [], timers: [], stopped: false });
  const orig = window.__CL_FETCH || window.fetch.bind(window);
  window.__CL_FETCH = orig;
  const now = () => Date.now();

  async function codeOf(res) {
    if (res.ok) return null;
    try {
      return (await res.clone().json()).code ?? null;
    } catch {
      return null;
    }
  }

  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    try {
      const h = (init && init.headers) || (input instanceof Request ? input.headers : null);
      const a = h && (typeof h.get === 'function' ? h.get('Authorization') : h.Authorization);
      if (a && a.startsWith('Bearer ')) CL.auth = a;
    } catch {}
    const seg =
      C.role === 'probe' && method === 'PUT' && /\/api\/lives\/[^/]+\/segments\/\d+/.test(url);
    if (!seg) return orig(input, init);
    const t0 = performance.now();
    const at = now();
    try {
      const res = await orig(input, init);
      CL.rows.push({
        kind: 'segment',
        at,
        ms: performance.now() - t0,
        status: res.status,
        code: await codeOf(res),
      });
      return res;
    } catch (e) {
      CL.rows.push({
        kind: 'segment',
        at,
        ms: performance.now() - t0,
        status: 0,
        code: String(e && e.name),
      });
      throw e;
    }
  };

  const pct = (xs, p) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
  };
  CL.summary = () => {
    const out = {};
    for (const kind of ['segment', 'message', 'reaction']) {
      const rows = CL.rows.filter((r) => r.kind === kind);
      if (rows.length === 0) continue;
      const byStatus = {};
      for (const r of rows) {
        const k = `${r.status}${r.code ? ' ' + r.code : ''}`;
        byStatus[k] = (byStatus[k] || 0) + 1;
      }
      const ms = rows.filter((r) => r.status >= 200 && r.status < 300).map((r) => r.ms);
      out[kind] = {
        n: rows.length,
        byStatus,
        p50: pct(ms, 50),
        p95: pct(ms, 95),
        p99: pct(ms, 99),
        max: pct(ms, 100),
      };
    }
    out.errors = CL.errors.slice(-5);
    return out;
  };
  CL.stop = () => {
    CL.stopped = true;
    CL.timers.forEach(clearInterval);
  };
  if (C.role === 'probe') return 'probe armed';

  // ---- the chat role --------------------------------------------------------------------------
  const hex = (s) => new Uint8Array(s.match(/../g).map((b) => parseInt(b, 16)));
  const uuidBytes = (u) => hex(u.replaceAll('-', '').toLowerCase());
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const api = (path, init = {}) =>
    orig(path, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: CL.auth,
        'Content-Type': 'application/json',
        'X-Canari-Client-Version': C.clientVersion,
      },
    });

  async function seal(key, liveId, clientId, author, text) {
    const enc = new TextEncoder();
    const label = enc.encode('canari-live-chat-v1');
    const a = enc.encode(author);
    const aad = new Uint8Array(label.length + 1 + 32 + a.length);
    aad.set(label, 0);
    aad.set(uuidBytes(liveId), label.length + 1);
    aad.set(uuidBytes(clientId), label.length + 17);
    aad.set(a, label.length + 33);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const body = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
        key,
        enc.encode(text)
      )
    );
    const out = new Uint8Array(12 + body.length);
    out.set(iv, 0);
    out.set(body, 12);
    return b64(out);
  }

  async function timed(kind, path, body) {
    const t0 = performance.now();
    const at = now();
    try {
      const res = await api(path, { method: 'POST', body: JSON.stringify(body) });
      const code = await codeOf(res);
      CL.rows.push({ kind, at, ms: performance.now() - t0, status: res.status, code });
      return res;
    } catch (e) {
      CL.rows.push({ kind, at, ms: performance.now() - t0, status: 0, code: String(e && e.name) });
      return null;
    }
  }

  return (async () => {
    const end = now() + 30000;
    while (!CL.auth && now() < end) await new Promise((r) => setTimeout(r, 500));
    if (!CL.auth) throw new Error('no Authorization header seen from the page');
    const live = await (await api(`/api/lives/${C.liveId}`)).json();
    // The author id the server stamps is the token's own subject (the 64-hex account id).
    const claims = JSON.parse(atob(CL.auth.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    CL.author = String(claims.sub).toLowerCase();
    const key = await crypto.subtle.importKey('raw', hex(live.key), { name: 'AES-GCM' }, false, [
      'encrypt',
    ]);
    let n = 0;
    CL.timers.push(
      setInterval(async () => {
        if (CL.stopped) return;
        const clientId = crypto.randomUUID();
        const sealed = await seal(key, C.liveId, clientId, CL.author, `${C.name} G8 ${++n}`);
        await timed('message', `/api/lives/${C.liveId}/messages`, { clientId, sealed });
      }, C.msgEveryMs)
    );
    CL.timers.push(
      setInterval(() => {
        if (CL.stopped) return;
        void timed('reaction', `/api/lives/${C.liveId}/reactions`, {
          burstId: crypto.randomUUID(),
          counts: { like: 2, fire: 1 },
        });
      }, C.burstEveryMs)
    );
    return `chat load armed as ${CL.author.slice(0, 8)}`;
  })();
})();
