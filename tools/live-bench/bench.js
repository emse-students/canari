// WP-L1 live bench - the page side, injected through the inspector (CDP / WebKit bridge) into a page.
// NOT shipped, NOT product code. See tools/live-bench/README.md.
//
// Set `window.__LB_CFG` first, then evaluate this file (inject.mjs does both). Roles:
//   { role: 'broadcast', target: 'dev' | 'mirror', api, bench?, segMs, bitrate, kfMs?, width?, height?, name }
//   { role: 'view', source: 'dev' | 'mirror', liveId, api, bench?, pollMs?, edgeS?, maxBehindS?, name }
//
// With 'dev' the page must be a page of an app SIGNED IN to dev (the Tauri app's WebView, or the web
// app in a browser): the bench reads the Authorization header the app itself sends (a fetch wrapper)
// and keeps it in this closure - it never leaves the page.
//
// ONE CLOCK: with 'dev' every page syncs to the server's clock (`serverNow` of the live's manifest,
// min-RTT of several reads), so a capture time on the broadcaster and a display time on a viewer
// are compared in one clock. 'mirror' syncs to the bench server (`server.mjs`) instead.
//
// Every sealed segment carries a small header in its plaintext - { i, recStart, segMs, mime,
// readyAt } - so a viewer needs nothing but the live's key and its segments.
//
// Results: window.__LB (segs, samples, events, errors), read over the inspector; and, when `bench`
// is set and reachable, also POSTed to <bench>/log/<name>-{seg,sample,event}.
(() => {
  const C = window.__LB_CFG;
  const LB = (window.__LB = {
    cfg: C,
    started: Date.now(),
    errors: [],
    events: [],
    segs: [],
    samples: [],
  });
  const t0 = performance.now();
  // The ENGINE's own fetch, for the bench server: the Tauri app replaces `window.fetch` with its HTTP
  // plugin, whose scope refuses a localhost URL. A fresh iframe still holds the native one.
  if (!window.__LB_NATIVE) {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.documentElement.appendChild(f);
    window.__LB_NATIVE = f.contentWindow.fetch.bind(f.contentWindow);
  }
  const benchFetch = window.__LB_NATIVE;
  let offset = 0; // reference clock - local clock (ms)
  const now = () => Date.now() + offset;
  const post = (kind, obj) => {
    if (C.bench)
      benchFetch(`${C.bench}/log/${C.name}-${kind}`, {
        method: 'POST',
        body: JSON.stringify({ ...obj, at: now() }),
      }).catch(() => {});
  };
  const ev = (m, extra = {}) => {
    const e = { t_s: +((performance.now() - t0) / 1000).toFixed(1), at: now(), m, ...extra };
    LB.events.push(e);
    post('event', e);
  };
  const err = (m) => {
    LB.errors.push(String(m));
    ev('error', { error: String(m) });
  };

  // --- the dev session: the page's own Authorization header, kept here ---------------------------
  const mode = C.target || C.source;
  if (mode === 'dev' && !window.__LB_FETCH) {
    const orig = window.fetch.bind(window);
    window.__LB_FETCH = orig;
    window.fetch = (input, init) => {
      try {
        const h = (init && init.headers) || (input instanceof Request ? input.headers : null);
        const a =
          h &&
          (typeof h.get === 'function'
            ? h.get('Authorization')
            : h.Authorization || h.authorization);
        if (a && a.startsWith('Bearer ')) window.__LB_AUTH = a;
      } catch {}
      return orig(input, init);
    };
  }
  const rawFetch = window.__LB_FETCH || window.fetch.bind(window);
  async function waitHeader(ms = 180000) {
    const end = Date.now() + ms;
    while (!window.__LB_AUTH && Date.now() < end) {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!window.__LB_AUTH) throw new Error('no Authorization header seen from the page in time');
  }
  // A web page parked on the PIN screen sends nothing authenticated: `selfRefresh` asks the server
  // for an access token with the page's own refresh cookie, as the app does, and keeps it here.
  async function selfRefresh() {
    const r = await rawFetch(`${C.api}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!r.ok) throw new Error(`refresh ${r.status}`);
    window.__LB_AUTH = 'Bearer ' + (await r.json()).access_token;
    ev('self-refreshed');
  }
  /** The page's session, by the route `selfRefresh` names. */
  const waitAuth = async () => {
    if (window.__LB_AUTH) return;
    if (C.selfRefresh) await selfRefresh();
    else await waitHeader();
  };
  if (C.selfRefresh) {
    LB.refresher = setInterval(
      () => selfRefresh().catch((e) => err('refresh ' + e.message)),
      40 * 60 * 1000
    );
  }
  const api = (path, init = {}) =>
    rawFetch(`${C.api}${path}`, {
      ...init,
      // The lives routes answer 404 to a request that names no build >= 1.5.4 (LiveEnabledGuard).
      headers: {
        ...init.headers,
        Authorization: window.__LB_AUTH,
        'X-Canari-Client-Version': '1.5.4',
      },
    });

  /** Min-RTT clock sync: against dev's manifest `serverNow`, or the bench server's /time. */
  async function syncClock(liveId, n = 7) {
    let best = null;
    for (let i = 0; i < n; i++) {
      const a = Date.now();
      let t;
      if (mode === 'dev') {
        const r = await api(`/api/lives/${liveId}/manifest`, { cache: 'no-store' });
        t = Date.parse((await r.json()).serverNow);
        if (!Number.isFinite(t)) throw new Error(`clock: no serverNow (${r.status})`);
      } else t = (await (await benchFetch(`${C.bench}/time`, { cache: 'no-store' })).json()).t;
      const b = Date.now();
      if (!best || b - a < best.rtt) best = { rtt: b - a, off: t - (a + b) / 2 };
    }
    offset = best.off;
    LB.clock = { ref: mode, offsetMs: Math.round(best.off), rttMs: best.rtt };
    return LB.clock;
  }

  // --- fMP4 reading: is a chunk box-aligned, and does its video start on a sync sample? -----------
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const typ = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  function boxes(b, s, e) {
    const out = [];
    let o = s;
    while (o + 8 <= e) {
      let size = u32(b, o);
      const t = typ(b, o + 4);
      if (size === 1) size = u32(b, o + 12);
      if (size < 8 || o + size > e) {
        out.push({ t, o, size, partial: true });
        break;
      }
      out.push({ t, o, size });
      o += size;
    }
    return out;
  }
  let videoTrack = null;
  const trexFlags = new Map(); // track id -> default_sample_flags (moov/mvex/trex)
  function readMoov(b, box) {
    for (const trak of boxes(b, box.o + 8, box.o + box.size).filter((x) => x.t === 'trak')) {
      const kids = boxes(b, trak.o + 8, trak.o + trak.size);
      const tkhd = kids.find((x) => x.t === 'tkhd');
      const mdia = kids.find((x) => x.t === 'mdia');
      if (!tkhd || !mdia) continue;
      const v = b[tkhd.o + 8];
      const id = u32(b, tkhd.o + 12 + (v === 1 ? 16 : 8));
      const hdlr = boxes(b, mdia.o + 8, mdia.o + mdia.size).find((x) => x.t === 'hdlr');
      if (hdlr && typ(b, hdlr.o + 16) === 'vide') videoTrack = id;
    }
    const mvex = boxes(b, box.o + 8, box.o + box.size).find((x) => x.t === 'mvex');
    if (mvex)
      for (const trex of boxes(b, mvex.o + 8, mvex.o + mvex.size).filter((x) => x.t === 'trex'))
        trexFlags.set(u32(b, trex.o + 12), u32(b, trex.o + 28));
  }
  /** { top, aligned, moofs, videoSync, initBytes } of one recorder chunk. */
  function inspect(buf) {
    const b = new Uint8Array(buf);
    const top = boxes(b, 0, b.length);
    const r = {
      top: top.map((x) => x.t).join(','),
      aligned: !top.some((x) => x.partial),
      moofs: 0,
      videoSync: null,
      initBytes: 0,
    };
    for (const box of top) {
      if (box.t === 'moov') {
        readMoov(b, box);
        r.initBytes = box.o + box.size;
      }
      if (box.t !== 'moof' || box.partial) continue;
      r.moofs++;
      if (r.videoSync !== null) continue;
      for (const traf of boxes(b, box.o + 8, box.o + box.size).filter((x) => x.t === 'traf')) {
        const kids = boxes(b, traf.o + 8, traf.o + traf.size);
        const tfhd = kids.find((x) => x.t === 'tfhd');
        const trun = kids.find((x) => x.t === 'trun');
        if (!tfhd || !trun) continue;
        if (videoTrack !== null && u32(b, tfhd.o + 12) !== videoTrack) continue;
        const tff = u32(b, tfhd.o + 8) & 0xffffff;
        let p = tfhd.o + 16;
        if (tff & 0x1) p += 8;
        if (tff & 0x2) p += 4;
        if (tff & 0x8) p += 4;
        if (tff & 0x10) p += 4;
        let flags =
          tff & 0x20
            ? u32(b, p)
            : trexFlags.has(u32(b, tfhd.o + 12))
              ? trexFlags.get(u32(b, tfhd.o + 12))
              : null;
        const trf = u32(b, trun.o + 8) & 0xffffff;
        let q = trun.o + 16;
        if (trf & 0x1) q += 4;
        if (trf & 0x4) flags = u32(b, q);
        else if (trf & 0x400) {
          if (trf & 0x100) q += 4;
          if (trf & 0x200) q += 4;
          flags = u32(b, q);
        }
        r.videoSync = flags === null ? null : !(flags & 0x10000);
        break;
      }
    }
    return r;
  }

  // --- sealing: AES-GCM-256, iv || ciphertext, the index as AAD; plaintext = header || fMP4 -------
  const hex = (u) => [...u].map((x) => x.toString(16).padStart(2, '0')).join('');
  const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
  const aad = (i) => new TextEncoder().encode(`live-bench:${i}`);
  async function seal(key, i, header, buf) {
    const h = new TextEncoder().encode(JSON.stringify(header));
    const plain = new Uint8Array(4 + h.length + buf.byteLength);
    new DataView(plain.buffer).setUint32(0, h.length);
    plain.set(h, 4);
    plain.set(new Uint8Array(buf), 4 + h.length);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(i) }, key, plain)
    );
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return out;
  }
  async function open(key, i, sealed) {
    const b = new Uint8Array(sealed);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b.slice(0, 12), additionalData: aad(i) },
        key,
        b.slice(12)
      )
    );
    const n = new DataView(plain.buffer).getUint32(0);
    return {
      header: JSON.parse(new TextDecoder().decode(plain.slice(4, 4 + n))),
      media: plain.slice(4 + n).buffer,
    };
  }
  const overlay = () => {
    const pre = document.createElement('pre');
    pre.style.cssText =
      'position:fixed;left:0;bottom:0;z-index:2147483647;background:#fff;color:#000;font:11px monospace;margin:0;padding:4px;max-width:100vw;white-space:pre-wrap';
    document.body.appendChild(pre);
    return pre;
  };

  // ===================================== BROADCAST ================================================
  async function broadcast() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    let liveId;
    if (mode === 'dev') {
      await waitAuth();
      const r = await api('/api/lives', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: hex(raw) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`POST /api/lives ${r.status} ${j.code || ''}`);
      liveId = j.id;
    } else {
      liveId = 'm' + hex(crypto.getRandomValues(new Uint8Array(6)));
      await benchFetch(`${C.bench}/m/${liveId}/meta`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keyHex: hex(raw) }),
      });
    }
    LB.liveId = liveId;
    await syncClock(liveId);
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: C.width || 1280 },
        height: { ideal: C.height || 720 },
        frameRate: { ideal: 30 },
        facingMode: 'environment',
      },
      audio: true,
    });
    const vt = stream.getVideoTracks()[0];
    LB.track = vt.getSettings();
    const preview = document.createElement('video');
    Object.assign(preview, { muted: true, playsInline: true, autoplay: true, srcObject: stream });
    preview.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;z-index:2147483646;background:#000';
    document.body.appendChild(preview);
    const pre = overlay();
    const mime = [
      'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
    ].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('no fMP4 recording on this engine');
    const opts = { mimeType: mime, videoBitsPerSecond: C.bitrate, audioBitsPerSecond: 64000 };
    if (C.kfMs) opts.videoKeyFrameIntervalDuration = C.kfMs;
    const rec = new MediaRecorder(stream, opts);
    LB.recMime = rec.mimeType || mime;
    let recStart = null;
    const queue = [];
    let uploading = false,
      index = 0,
      bytes = 0,
      upMsSum = 0,
      upN = 0,
      upFail = 0;
    const pump = async () => {
      if (uploading || !queue.length) return;
      uploading = true;
      const s = queue.shift();
      s.queueAtStart = queue.length;
      s.upStart = now();
      // An index is NEVER skipped (the ingest takes them in order): a transport failure is retried
      // for up to 120 s, which is past the 60 s reconnect window the server ends a live on.
      const giveUp = Date.now() + 120000;
      for (let attempt = 0; Date.now() < giveUp; attempt++) {
        try {
          let r;
          if (mode === 'dev')
            r = await api(`/api/lives/${liveId}/segments/${s.i}`, {
              method: 'PUT',
              headers: { 'content-type': 'application/octet-stream' },
              body: s.sealed,
            });
          else
            r = await benchFetch(`${C.bench}/m/${liveId}/seg/${s.i}`, {
              method: 'POST',
              body: s.sealed,
            });
          s.status = r.status;
          if (r.ok) break;
          s.refusal = (await r.text()).slice(0, 160);
          if (![409, 429, 503].includes(r.status)) break;
        } catch (e) {
          s.status = 'net:' + (e && e.name);
        }
        s.retries = attempt + 1;
        await new Promise((r) => setTimeout(r, Math.min(4000, 500 * (attempt + 1))));
      }
      if (s.status !== 200) upFail++;
      s.upEnd = now();
      s.upMs = s.upEnd - s.upStart;
      upMsSum += s.upMs;
      upN++;
      delete s.sealed;
      LB.segs.push(s);
      post('seg', s);
      uploading = false;
      pump();
    };
    rec.onstart = () => {
      recStart = now();
      LB.recStart = recStart;
      ev('recording', {
        mime: LB.recMime,
        w: LB.track.width,
        h: LB.track.height,
        fps: LB.track.frameRate,
        liveId,
      });
    };
    rec.ondataavailable = async (e) => {
      if (!e.data || !e.data.size) return;
      const readyAt = now();
      const i = index++;
      const buf = await e.data.arrayBuffer();
      bytes += buf.byteLength;
      const info = inspect(buf);
      const s0 = performance.now();
      const sealed = await seal(
        key,
        i,
        { i, recStart, segMs: C.segMs, mime: LB.recMime, readyAt },
        buf
      );
      const sealMs = performance.now() - s0;
      queue.push({
        i,
        bytes: buf.byteLength,
        readyAt,
        sealMs: +sealMs.toFixed(2),
        ...info,
        sealed,
      });
      pump();
    };
    rec.onerror = (e) => err('recorder ' + (e.error && e.error.name));
    vt.onmute = () => ev('track muted');
    vt.onunmute = () => ev('track unmuted');
    vt.onended = () => ev('track ended');
    document.addEventListener('visibilitychange', () =>
      ev('visibility ' + document.visibilityState)
    );
    rec.start(C.segMs);
    LB.sample = () => {
      const s = {
        t_s: Math.round((performance.now() - t0) / 1000),
        at: now(),
        segs: index,
        uploaded: upN,
        upFail,
        queue: queue.length,
        mb: +(bytes / 1e6).toFixed(1),
        kbps_avg: recStart ? Math.round((bytes * 8) / (now() - recStart)) : 0,
        up_ms_avg: upN ? Math.round(upMsSum / upN) : 0,
        rec: rec.state,
        track: vt.readyState,
        muted: vt.muted,
        vis: document.visibilityState,
        clock: LB.clock,
      };
      pre.textContent = `LIVE ${liveId}\n` + JSON.stringify(s);
      LB.samples.push(s);
      post('sample', s);
      return s;
    };
    LB.timer = setInterval(LB.sample, 10000);
    LB.resync = setInterval(() => syncClock(liveId).catch(() => {}), 120000);
    LB.stop = async () => {
      clearInterval(LB.timer);
      clearInterval(LB.resync);
      rec.stop();
      stream.getTracks().forEach((t) => t.stop());
      await new Promise((r) => setTimeout(r, 4000));
      if (mode === 'dev') {
        const r = await api(`/api/lives/${liveId}/end`, { method: 'POST' });
        ev('ended', { status: r.status });
      }
      return LB.sample();
    };
  }

  // ======================================= VIEW ===================================================
  async function view() {
    const liveId = C.liveId;
    let keyHex;
    if (mode === 'dev') {
      await waitAuth();
      const r = await api(`/api/lives/${liveId}`);
      const j = await r.json();
      if (!r.ok) throw new Error(`GET live ${r.status} ${j.code || ''}`);
      keyHex = j.key;
    } else keyHex = (await (await benchFetch(`${C.bench}/m/${liveId}/meta`)).json()).keyHex;
    await syncClock(liveId);
    const key = await crypto.subtle.importKey('raw', unhex(keyHex), 'AES-GCM', false, ['decrypt']);
    const manifest = async (from) => {
      const q = from === undefined ? '' : `?from=${from}`;
      const r =
        mode === 'dev'
          ? await api(`/api/lives/${liveId}/manifest${q}`)
          : await benchFetch(`${C.bench}/m/${liveId}/manifest${q}`);
      if (r.status === 410) return { gone: true, segments: [] };
      if (!r.ok) throw new Error(`manifest ${r.status}`);
      return r.json();
    };
    const getSeg = async (s) => {
      const r =
        mode === 'dev'
          ? await api(`/api/media/live/${liveId}/${s.name}`)
          : await benchFetch(`${C.bench}/m/${liveId}/seg/${s.index}`);
      if (!r.ok) throw new Error(`segment ${s.index} ${r.status}`);
      return r.arrayBuffer();
    };
    const MS = window.MediaSource || window.ManagedMediaSource;
    LB.msKind = window.MediaSource
      ? 'MediaSource'
      : window.ManagedMediaSource
        ? 'ManagedMediaSource'
        : 'none';
    if (!MS) throw new Error('no MediaSource and no ManagedMediaSource');
    const video = document.createElement('video');
    Object.assign(video, { muted: true, playsInline: true, autoplay: true });
    video.disableRemotePlayback = true;
    video.style.cssText =
      'position:fixed;left:0;top:0;width:100vw;height:100vh;object-fit:contain;z-index:2147483646;background:#000';
    const ms = new MS();
    video.src = URL.createObjectURL(ms);
    document.body.appendChild(video);
    const pre = overlay();
    await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
    // The init: segment 0, as MediaRecorder writes it.
    const m0 = await manifest(0);
    const s0 = m0.segments.find((s) => s.index === 0);
    if (!s0) throw new Error('segment 0 (the init) is not in the manifest');
    const o0 = await open(key, 0, await getSeg(s0));
    const meta = o0.header;
    LB.meta = meta;
    const info0 = inspect(o0.media);
    const sbType = meta.mime.includes('codecs')
      ? meta.mime.replace(/codecs=([^;"]+)/, 'codecs="$1"')
      : 'video/mp4; codecs="avc1.42E01F,mp4a.40.2"';
    LB.sbType = sbType;
    LB.sbSupported = MS.isTypeSupported(sbType);
    const sb = ms.addSourceBuffer(sbType);
    sb.mode = 'segments';
    let streaming = true;
    if ('streaming' in ms) {
      streaming = ms.streaming;
      ms.addEventListener('startstreaming', () => {
        streaming = true;
        ev('startstreaming');
      });
      ms.addEventListener('endstreaming', () => {
        streaming = false;
        ev('endstreaming');
      });
    }
    const append = (buf) =>
      new Promise((res, rej) => {
        const go = () => {
          const done = () => {
            sb.removeEventListener('error', bad);
            res();
          };
          const bad = () => {
            sb.removeEventListener('updateend', done);
            rej(new Error('sb error'));
          };
          sb.addEventListener('updateend', done, { once: true });
          sb.addEventListener('error', bad, { once: true });
          try {
            sb.appendBuffer(buf);
          } catch (e) {
            sb.removeEventListener('updateend', done);
            sb.removeEventListener('error', bad);
            rej(e);
          }
        };
        if (sb.updating) sb.addEventListener('updateend', go, { once: true });
        else go();
      });
    const trim = async () => {
      if (!sb.buffered.length || sb.updating) return;
      const ct = video.currentTime;
      if (ct - sb.buffered.start(0) > 30)
        await new Promise((r) => {
          sb.addEventListener('updateend', r, { once: true });
          sb.remove(0, ct - 10);
        });
    };
    await append(info0.initBytes ? o0.media.slice(0, info0.initBytes) : o0.media);
    let stallStart = null,
      stallMs = 0,
      stalls = 0,
      seeks = 0,
      last = 0,
      appendErr = 0;
    video.addEventListener('waiting', () => {
      if (stallStart === null) {
        stallStart = performance.now();
        stalls++;
      }
    });
    const unstall = () => {
      if (stallStart !== null) {
        stallMs += performance.now() - stallStart;
        stallStart = null;
      }
    };
    video.addEventListener('playing', unstall);
    const seekToEdge = (why) => {
      if (!sb.buffered.length) return;
      const end = sb.buffered.end(sb.buffered.length - 1);
      const start = sb.buffered.start(sb.buffered.length - 1);
      video.currentTime = Math.max(start, end - (C.edgeS || 1.0));
      seeks++;
      ev('seek to edge', { why, end: +end.toFixed(2) });
      video.play().catch(() => {});
    };
    const take = async (s, seenAt) => {
      const fetchStart = now();
      const sealed = await getSeg(s);
      const fetchedAt = now();
      const { header, media } = await open(key, s.index, sealed);
      const info = inspect(media);
      const body = s.index === 0 && info.initBytes ? media.slice(info.initBytes) : media;
      try {
        if (body.byteLength) await append(body);
      } catch (e) {
        appendErr++;
        err('append ' + s.index + ' ' + (e && e.message));
      }
      const appendedAt = now();
      // Capture of this segment's LAST frame ~= the moment the recorder handed it over.
      const rec = {
        i: s.index,
        bytes: s.bytes,
        readyAt: header.readyAt,
        seenAt,
        fetchMs: fetchedAt - fetchStart,
        appendedAt,
        readyToPlayableMs: appendedAt - header.readyAt,
        videoSync: info.videoSync,
      };
      LB.segs.push(rec);
      post('seg', rec);
      last = s.index;
      await trim();
    };
    // Join at the newest segment, then follow.
    const mf = await manifest();
    const newest = mf.segments[mf.segments.length - 1];
    if (newest && newest.index > 0) await take(newest, now());
    seekToEdge('join');
    ev('joined', {
      atIndex: newest && newest.index,
      msKind: LB.msKind,
      sbSupported: LB.sbSupported,
      secure: isSecureContext,
    });
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const seenAt = now();
        const m = await manifest(last + 1);
        if (m.gone) {
          clearInterval(LB.poller);
          LB.endedAt = now();
          ev('live ended (410)');
          return;
        }
        for (const s of m.segments) if (s.index > last) await take(s, seenAt);
        if (sb.buffered.length) {
          const behind = sb.buffered.end(sb.buffered.length - 1) - video.currentTime;
          if (behind > (C.maxBehindS || 6)) seekToEdge('behind ' + behind.toFixed(1));
        }
        if (video.paused && !document.hidden) video.play().catch(() => {});
      } finally {
        busy = false;
      }
    };
    LB.poller = setInterval(() => {
      poll().catch((e) => err('poll ' + (e && e.message)));
    }, C.pollMs || 500);
    LB.sample = () => {
      const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
      const be = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;
      // Glass-to-glass: the frame on screen was captured at recStart + its media time.
      const s = {
        t_s: Math.round((performance.now() - t0) / 1000),
        at: now(),
        last,
        ct: +video.currentTime.toFixed(2),
        behindS: +(be - video.currentTime).toFixed(2),
        g2gMs: Math.round(now() - (meta.recStart + video.currentTime * 1000)),
        stalls,
        stallMs: Math.round(stallMs + (stallStart !== null ? performance.now() - stallStart : 0)),
        seeks,
        appendErr,
        dropped: q.droppedVideoFrames,
        frames: q.totalVideoFrames,
        paused: video.paused,
        rs: video.readyState,
        streaming,
        vis: document.visibilityState,
        clock: LB.clock,
      };
      pre.textContent = `VIEW ${liveId} ${LB.msKind}\n` + JSON.stringify(s);
      LB.samples.push(s);
      post('sample', s);
      return s;
    };
    LB.timer = setInterval(LB.sample, C.sampleMs || 5000);
    LB.resync = setInterval(() => syncClock(liveId).catch(() => {}), 120000);
    LB.stop = () => {
      clearInterval(LB.poller);
      clearInterval(LB.timer);
      clearInterval(LB.resync);
      return LB.sample();
    };
  }

  (C.role === 'broadcast' ? broadcast() : view()).then(
    () => {
      LB.ok = true;
    },
    (e) => err('fatal ' + (e && e.name) + ' ' + (e && e.message))
  );
  return 'started ' + C.role;
})();
