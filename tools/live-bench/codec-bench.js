// Live bitrate-floor and codec bench (live-scaling stage 0 (ii)) - the page side.
// NOT shipped, NOT product code. See tools/live-bench/README.md, "The bitrate floor and codec bench".
//
// Evaluated in an inspectable page (the app WebView over CDP, iPhone Safari over the WebKit bridge,
// or served as codec-bench.html), it defines `window.__CB`:
//   __CB.matrix()                         encode/decode support for H.264, H.265, AV1 (+ VP8/VP9)
//   __CB.start('mr', { w, h, bps, durS }) MediaRecorder, video only, fMP4 H.264 baseline, 2 s slices
//   __CB.start('wc', { codec, w, h, bps, durS, mode, hw })  WebCodecs VideoEncoder, 2 s keyframes
//   __CB.state()                          { busy, step, results: [...] } without the media bytes
//   __CB.show(i, atS)                     decode result i at ~atS seconds and show the frame full screen
//   __CB.preview(w, h) / __CB.clear()     the raw camera, for a reference screenshot / tear down
// Nothing leaves the page: no network, no account.
(() => {
  // `__CB_SRC` (set by codec.mjs) names this source: the same source already loaded keeps its
  // results, a changed one replaces it.
  if (window.__CB && window.__CB.src === window.__CB_SRC) return;
  if (window.__CB) window.__CB.clear();
  const CB = (window.__CB = { src: window.__CB_SRC, busy: false, step: '', results: [], errors: [] });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const err = (e) => CB.errors.push(String((e && e.stack) || e).slice(0, 400));

  // --- the full-screen layer every view draws into -------------------------------------------
  let layer = null;
  function getLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement('div');
    layer.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:#000;color:#0f0;font:12px monospace;overflow:hidden';
    document.documentElement.appendChild(layer);
    return layer;
  }
  function label(text) {
    const l = getLayer();
    let p = l.querySelector('pre');
    if (!p) {
      p = document.createElement('pre');
      p.style.cssText =
        'position:absolute;left:0;bottom:40px;right:0;margin:0;padding:6px;background:rgba(0,0,0,.7);white-space:pre-wrap;z-index:2';
      l.appendChild(p);
    }
    p.textContent = text;
  }
  function stage(el) {
    const l = getLayer();
    for (const c of [...l.children]) if (c.tagName !== 'PRE') c.remove();
    el.style.cssText = 'position:absolute;left:0;top:60px;width:100%;height:auto;display:block';
    l.appendChild(el);
  }
  let camStream = null;
  let synthStop = null;
  function stopCam() {
    if (camStream) for (const t of camStream.getTracks()) t.stop();
    camStream = null;
    if (synthStop) synthStop();
    synthStop = null;
  }
  /**
   * A SYNTHETIC busy scene, the same on every phone: a seeded texture of circles and text (drawn
   * once, three frames wide) panned 2 px a frame, a turning bar and a frame counter. A bench phone
   * lying on a desk films a near-flat surface, which tells nothing about a speaker in a lit room;
   * this is the reproducible worst case beside it. Played through a <video> so both encoders read
   * it exactly as they read the camera.
   */
  async function synthetic(w, h) {
    stopCam();
    const tex = document.createElement('canvas');
    tex.width = w * 3;
    tex.height = h;
    const t = tex.getContext('2d');
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    t.fillStyle = '#6b6b6b';
    t.fillRect(0, 0, tex.width, h);
    for (let i = 0; i < 900; i++) {
      t.fillStyle = `hsla(${Math.floor(rnd() * 360)},${Math.floor(30 + rnd() * 60)}%,${Math.floor(20 + rnd() * 60)}%,${(0.4 + rnd() * 0.6).toFixed(2)})`;
      t.beginPath();
      t.arc(rnd() * tex.width, rnd() * h, 3 + rnd() * (h / 12), 0, 7);
      t.fill();
    }
    for (let i = 0; i < 120; i++) {
      t.fillStyle = rnd() > 0.5 ? '#fff' : '#111';
      t.font = `${Math.floor(10 + rnd() * 30)}px sans-serif`;
      t.fillText('Canari live bench 0123456789', rnd() * tex.width, rnd() * h);
    }
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    let frame = 0;
    const draw = () => {
      const x = (frame * 2) % (tex.width - w);
      ctx.drawImage(tex, x, 0, w, h, 0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(frame / 20);
      ctx.fillStyle = '#e33';
      ctx.fillRect(-h / 4, -h / 40, h / 2, h / 20);
      ctx.restore();
      ctx.fillStyle = '#000';
      ctx.fillRect(10, 10, 150, 34);
      ctx.fillStyle = '#ff0';
      ctx.font = '28px monospace';
      ctx.fillText(String(frame), 16, 38);
      frame++;
    };
    draw();
    const timer = setInterval(draw, 1000 / 30);
    camStream = cv.captureStream(30);
    synthStop = () => clearInterval(timer);
    const v = document.createElement('video');
    Object.assign(v, { muted: true, playsInline: true, autoplay: true, srcObject: camStream });
    v.setAttribute('playsinline', '');
    await v.play().catch(() => {});
    for (let i = 0; i < 100 && !v.videoWidth; i++) await sleep(50);
    return { stream: camStream, video: v, settings: { width: w, height: h, frameRate: 30, synthetic: true } };
  }
  const source = (src, w, h) => (src === 'synthetic' ? synthetic(w, h) : camera(w, h));
  async function camera(w, h) {
    stopCam();
    camStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: w },
        height: { ideal: h },
        frameRate: { ideal: 30 },
        facingMode: 'environment',
      },
      audio: false,
    });
    const v = document.createElement('video');
    Object.assign(v, { muted: true, playsInline: true, autoplay: true, srcObject: camStream });
    v.setAttribute('playsinline', '');
    await v.play().catch(() => {});
    for (let i = 0; i < 100 && !v.videoWidth; i++) await sleep(50);
    return { stream: camStream, video: v, settings: camStream.getVideoTracks()[0].getSettings() };
  }
  CB.preview = async (w = 1280, h = 720) => {
    const { video, settings } = await camera(w, h);
    stage(video);
    label(`RAW CAMERA ${settings.width}x${settings.height}@${settings.frameRate}`);
    return settings;
  };
  CB.clear = () => {
    stopCam();
    if (layer) layer.remove();
    layer = null;
    return true;
  };

  // --- support matrix ---------------------------------------------------------------------------
  const ENC = [
    ['H.264 baseline', 'avc1.42E01F'],
    ['H.264 main', 'avc1.4D401F'],
    ['H.264 high', 'avc1.64001F'],
    ['H.265 hvc1', 'hvc1.1.6.L93.B0'],
    ['H.265 hev1', 'hev1.1.6.L93.B0'],
    ['AV1', 'av01.0.05M.08'],
    ['VP8', 'vp8'],
    ['VP9', 'vp09.00.31.08'],
  ];
  const mrType = (c) =>
    c === 'vp8' || c.startsWith('vp09') ? `video/webm;codecs=${c}` : `video/mp4;codecs=${c}`;
  const mseType = (c) =>
    c === 'vp8' || c.startsWith('vp09') ? `video/webm; codecs="${c}"` : `video/mp4; codecs="${c}"`;
  async function sup(fn) {
    try {
      const r = await fn();
      return r && typeof r === 'object' && 'supported' in r ? r.supported : r;
    } catch (e) {
      return 'throw:' + (e && e.name);
    }
  }
  CB.matrix = async () => {
    const MS = window.MediaSource || window.ManagedMediaSource;
    const out = {
      ua: navigator.userAgent,
      api: {
        MediaRecorder: typeof MediaRecorder,
        VideoEncoder: typeof VideoEncoder,
        VideoDecoder: typeof VideoDecoder,
        MediaSource: typeof window.MediaSource,
        ManagedMediaSource: typeof window.ManagedMediaSource,
        MediaStreamTrackProcessor: typeof window.MediaStreamTrackProcessor,
      },
      rows: [],
    };
    for (const [name, c] of ENC) {
      const base = { codec: c, width: 1280, height: 720, bitrate: 1_000_000, framerate: 30 };
      const encCfg = (extra) => () => VideoEncoder.isConfigSupported({ ...base, ...extra });
      const decCfg = (extra) => () =>
        VideoDecoder.isConfigSupported({ codec: c, codedWidth: 1280, codedHeight: 720, ...extra });
      const row = {
        name,
        codec: c,
        mrRecord: typeof MediaRecorder !== 'undefined' ? MediaRecorder.isTypeSupported(mrType(c)) : null,
        wcEnc: typeof VideoEncoder !== 'undefined' ? await sup(encCfg({})) : null,
        wcEncHw:
          typeof VideoEncoder !== 'undefined'
            ? await sup(encCfg({ hardwareAcceleration: 'prefer-hardware' }))
            : null,
        wcEncSw:
          typeof VideoEncoder !== 'undefined'
            ? await sup(encCfg({ hardwareAcceleration: 'prefer-software' }))
            : null,
        wcEncCbr:
          typeof VideoEncoder !== 'undefined' ? await sup(encCfg({ bitrateMode: 'constant' })) : null,
        mseDecode: MS ? MS.isTypeSupported(mseType(c)) : null,
        wcDec: typeof VideoDecoder !== 'undefined' ? await sup(decCfg({})) : null,
        wcDecHw:
          typeof VideoDecoder !== 'undefined'
            ? await sup(decCfg({ hardwareAcceleration: 'prefer-hardware' }))
            : null,
      };
      try {
        const d = await navigator.mediaCapabilities.decodingInfo({
          type: 'media-source',
          video: { contentType: mseType(c), width: 1280, height: 720, bitrate: 1e6, framerate: 30 },
        });
        row.mcDecode = `${d.supported ? 'S' : '-'}${d.smooth ? 'm' : '-'}${d.powerEfficient ? 'P' : '-'}`;
      } catch (e) {
        row.mcDecode = 'throw:' + e.name;
      }
      try {
        const d = await navigator.mediaCapabilities.encodingInfo({
          type: 'record',
          video: { contentType: mrType(c), width: 1280, height: 720, bitrate: 1e6, framerate: 30 },
        });
        row.mcEncode = `${d.supported ? 'S' : '-'}${d.smooth ? 'm' : '-'}${d.powerEfficient ? 'P' : '-'}`;
      } catch (e) {
        row.mcEncode = 'throw:' + e.name;
      }
      out.rows.push(row);
    }
    return out;
  };

  // --- fMP4 reading: does each chunk's first video fragment start on a sync sample? ------------
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
  /** { moofs, sync, initBytes } of one recorder chunk: sync is the first sample's flag. */
  function inspect(buf, st) {
    const b = new Uint8Array(buf);
    const r = { moofs: 0, sync: null, initBytes: 0 };
    for (const box of boxes(b, 0, b.length)) {
      if (box.t === 'moov') {
        r.initBytes = box.o + box.size;
        const mvex = boxes(b, box.o + 8, box.o + box.size).find((x) => x.t === 'mvex');
        if (mvex)
          for (const trex of boxes(b, mvex.o + 8, mvex.o + mvex.size).filter((x) => x.t === 'trex'))
            st.trex = u32(b, trex.o + 28);
      }
      if (box.t !== 'moof' || box.partial) continue;
      r.moofs++;
      if (r.sync !== null) continue;
      const traf = boxes(b, box.o + 8, box.o + box.size).find((x) => x.t === 'traf');
      if (!traf) continue;
      const kids = boxes(b, traf.o + 8, traf.o + traf.size);
      const tfhd = kids.find((x) => x.t === 'tfhd');
      const trun = kids.find((x) => x.t === 'trun');
      if (!tfhd || !trun) continue;
      const tff = u32(b, tfhd.o + 8) & 0xffffff;
      let p = tfhd.o + 16;
      if (tff & 0x1) p += 8;
      if (tff & 0x2) p += 4;
      if (tff & 0x8) p += 4;
      if (tff & 0x10) p += 4;
      let flags = tff & 0x20 ? u32(b, p) : st.trex ?? null;
      const trf = u32(b, trun.o + 8) & 0xffffff;
      let q = trun.o + 16;
      if (trf & 0x1) q += 4;
      if (trf & 0x4) flags = u32(b, q);
      else if (trf & 0x400) {
        if (trf & 0x100) q += 4;
        if (trf & 0x200) q += 4;
        flags = u32(b, q);
      }
      r.sync = flags === null ? null : !(flags & 0x10000);
    }
    return r;
  }
  const mbps = (bytes, s) => +((bytes * 8) / s / 1e6).toFixed(3);
  const pct = (a, p) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
  };

  // --- MediaRecorder ----------------------------------------------------------------------------
  async function runMr({ w, h, bps, durS = 60, segMs = 2000, kfMs = 2000, src = 'camera' }) {
    const mime = 'video/mp4;codecs=avc1.42E01F';
    const res = { api: 'MediaRecorder', src, w, h, bps, durS, segMs, kfMs, mime };
    if (!MediaRecorder.isTypeSupported(mime)) return { ...res, error: 'type unsupported' };
    const { stream, video, settings } = await source(src, w, h);
    res.track = { w: settings.width, h: settings.height, fps: settings.frameRate };
    stage(video);
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: bps,
      videoKeyFrameIntervalDuration: kfMs,
    });
    res.recMime = rec.mimeType;
    const chunks = [];
    const st = {};
    let t0 = 0;
    rec.ondataavailable = async (e) => {
      const at = performance.now() - t0;
      const buf = await e.data.arrayBuffer();
      chunks.push({ at, size: buf.byteLength, buf, ...(buf.byteLength ? inspect(buf, st) : {}) });
    };
    const stopped = new Promise((r) => (rec.onstop = r));
    const started = new Promise((r) => (rec.onstart = r));
    rec.start(segMs);
    await started;
    t0 = performance.now();
    const tick = setInterval(() => {
      const bytes = chunks.reduce((a, c) => a + c.size, 0);
      const s = (performance.now() - t0) / 1000;
      label(
        `MR ${w}x${h} ask ${bps / 1e6} Mb/s  t=${s.toFixed(0)}s  chunks=${chunks.length}  ~${mbps(bytes, s)} Mb/s\ntrack ${res.track.w}x${res.track.h}`
      );
    }, 1000);
    await sleep(durS * 1000);
    rec.stop();
    await stopped;
    await sleep(300);
    clearInterval(tick);
    const wall = (performance.now() - t0) / 1000;
    stopCam();
    const init = chunks.length ? chunks[0].initBytes || 0 : 0;
    const total = chunks.reduce((a, c) => a + c.size, 0);
    const media = chunks.filter((c) => c.size > 0);
    const sizes = chunks.map((c) => c.size);
    // Steady state: the first 10 s carry the encoder's ramp; the last 50 s are the answer.
    const late = chunks.filter((c) => c.at >= 10000);
    const lateBytes = late.reduce((a, c) => a + c.size, 0);
    const lateSpan = late.length ? (late[late.length - 1].at - late[0].at) / 1000 + segMs / 1000 : 0;
    Object.assign(res, {
      wallS: +wall.toFixed(1),
      chunks: chunks.length,
      empty: chunks.length - media.length,
      initBytes: init,
      totalBytes: total,
      deliveredMbps: mbps(total - init, wall),
      steadyMbps: lateSpan ? mbps(lateBytes, lateSpan) : null,
      segKB: {
        p10: +(pct(sizes, 0.1) / 1024).toFixed(1),
        p50: +(pct(sizes, 0.5) / 1024).toFixed(1),
        p90: +(pct(sizes, 0.9) / 1024).toFixed(1),
        max: +(Math.max(...sizes) / 1024).toFixed(1),
      },
      // A chunk with no fragment (the init alone) is counted apart, not as a misaligned one.
      noFragment: media.filter((c) => !c.moofs).length,
      keyAligned: `${media.filter((c) => c.moofs && c.sync === true).length}/${media.filter((c) => c.moofs).length}`,
      moofsPerChunk: [...new Set(media.map((c) => c.moofs))].join(','),
    });
    res._chunks = chunks;
    return res;
  }

  // --- WebCodecs VideoEncoder ---------------------------------------------------------------------
  async function runWc({
    codec,
    w,
    h,
    bps,
    durS = 60,
    mode = 'constant',
    hw = 'prefer-hardware',
    kfFrames = 60,
    src = 'camera',
  }) {
    if (typeof VideoEncoder === 'undefined') return { api: 'VideoEncoder', codec, error: 'no VideoEncoder' };
    // The camera first: a phone held upright delivers a portrait track, and the encoder takes the
    // track's orientation (as MediaRecorder does), so w x h is swapped to match it.
    const { video, settings } = await source(src, w, h);
    if (settings.height > settings.width && w > h) [w, h] = [h, w];
    const res = { api: 'VideoEncoder', src, codec, w, h, bps, durS, kfFrames };
    res.track = { w: settings.width, h: settings.height, fps: settings.frameRate };
    const base = { codec, width: w, height: h, bitrate: bps, framerate: 30, latencyMode: 'realtime' };
    if (codec.startsWith('avc')) base.avc = { format: 'avc' };
    // Probe: the asked mode and hardware first, then step back, recording each answer.
    res.probe = {};
    let cfg = null;
    for (const m of [mode, 'variable']) {
      for (const a of [hw, 'no-preference']) {
        const c = { ...base, bitrateMode: m, hardwareAcceleration: a };
        let ok;
        try {
          ok = (await VideoEncoder.isConfigSupported(c)).supported;
        } catch (e) {
          ok = 'throw:' + e.name;
        }
        res.probe[`${m}/${a}`] = ok;
        if (ok === true && !cfg) cfg = c;
      }
    }
    if (!cfg) {
      stopCam();
      return { ...res, error: 'no supported config' };
    }
    res.used = { bitrateMode: cfg.bitrateMode, hardwareAcceleration: cfg.hardwareAcceleration };
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    stage(cv);
    const chunks = [];
    let decoderConfig = null;
    let encErr = null;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && !decoderConfig) decoderConfig = meta.decoderConfig;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ type: chunk.type, ts: chunk.timestamp, size: chunk.byteLength, data });
      },
      error: (e) => (encErr = String(e)),
    });
    enc.configure(cfg);
    let n = 0;
    let dropped = 0;
    let running = true;
    const t0 = performance.now();
    // Cover-crop the camera into exactly w x h, then encode the canvas.
    const draw = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const s = Math.max(w / vw, h / vh);
      const dw = vw * s;
      const dh = vh * s;
      ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
    };
    const onFrame = () => {
      if (!running) return;
      if (enc.state === 'configured') {
        if (enc.encodeQueueSize > 4) dropped++;
        else {
          draw();
          const f = new VideoFrame(cv, { timestamp: Math.round((performance.now() - t0) * 1000) });
          enc.encode(f, { keyFrame: n % kfFrames === 0 });
          f.close();
          n++;
        }
      }
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
      else setTimeout(onFrame, 33);
    };
    onFrame();
    const tick = setInterval(() => {
      const bytes = chunks.reduce((a, c) => a + c.size, 0);
      const s = (performance.now() - t0) / 1000;
      label(
        `WC ${codec} ${w}x${h} ask ${bps / 1e6} Mb/s ${cfg.bitrateMode}/${cfg.hardwareAcceleration}\nt=${s.toFixed(0)}s frames=${n} dropped=${dropped} ~${mbps(bytes, s)} Mb/s${encErr ? ' ERR ' + encErr : ''}`
      );
    }, 1000);
    await sleep(durS * 1000);
    running = false;
    try {
      await enc.flush();
    } catch (e) {
      encErr = encErr || String(e);
    }
    clearInterval(tick);
    const wall = (performance.now() - t0) / 1000;
    enc.close();
    stopCam();
    const total = chunks.reduce((a, c) => a + c.size, 0);
    // Bytes per 2 s window of media time, i.e. what a 2 s segment would weigh.
    const win = new Map();
    for (const c of chunks) {
      const k = Math.floor(c.ts / 2e6);
      win.set(k, (win.get(k) || 0) + c.size);
    }
    const wins = [...win.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const steady = wins.slice(5, -1);
    const keys = chunks.filter((c) => c.type === 'key');
    Object.assign(res, {
      wallS: +wall.toFixed(1),
      framesIn: n,
      framesOut: chunks.length,
      dropped,
      fps: +(chunks.length / wall).toFixed(1),
      keyframes: keys.length,
      keyKB: +(keys.reduce((a, c) => a + c.size, 0) / Math.max(1, keys.length) / 1024).toFixed(1),
      totalBytes: total,
      deliveredMbps: mbps(total, wall),
      steadyMbps: steady.length ? mbps(steady.reduce((a, b) => a + b, 0), steady.length * 2) : null,
      segKB: {
        p10: +(pct(wins, 0.1) / 1024).toFixed(1),
        p50: +(pct(wins, 0.5) / 1024).toFixed(1),
        p90: +(pct(wins, 0.9) / 1024).toFixed(1),
        max: +(Math.max(...wins) / 1024).toFixed(1),
      },
      decoderCodec: decoderConfig && decoderConfig.codec,
      encodeError: encErr,
    });
    res._chunks = chunks;
    res._decoderConfig = decoderConfig;
    return res;
  }

  // --- the queue: one run at a time, results kept with their bytes for show() -----------------------
  CB.start = (kind, opts) => {
    if (CB.busy) return 'busy';
    CB.busy = true;
    CB.step = `${kind} ${JSON.stringify(opts)}`;
    (async () => {
      try {
        const r = kind === 'mr' ? await runMr(opts) : await runWc(opts);
        r.index = CB.results.length;
        CB.results.push(r);
      } catch (e) {
        err(e);
        CB.results.push({ index: CB.results.length, kind, opts, error: String(e) });
      } finally {
        CB.busy = false;
        CB.step = '';
      }
    })();
    return 'started';
  };
  const strip = (r) => {
    const o = {};
    for (const k of Object.keys(r)) if (!k.startsWith('_')) o[k] = r[k];
    return o;
  };
  CB.state = () => ({ busy: CB.busy, step: CB.step, errors: CB.errors, results: CB.results.map(strip) });

  // --- show a decoded frame ---------------------------------------------------------------------
  CB.show = async (i, atS = 30) => {
    const r = CB.results[i];
    if (!r || !r._chunks) throw new Error('no result ' + i);
    const tag = `${r.api} [${r.src}] ${r.codec || r.mime} ${r.w}x${r.h} ask ${r.bps / 1e6} Mb/s -> ${r.steadyMbps} Mb/s steady (decoded frame ~${atS}s)`;
    if (r.api === 'MediaRecorder') {
      const MS = window.ManagedMediaSource || window.MediaSource;
      const ms = new MS();
      const v = document.createElement('video');
      Object.assign(v, { muted: true, playsInline: true });
      v.disableRemotePlayback = true;
      if (window.ManagedMediaSource && MS === window.ManagedMediaSource) v.srcObject = ms;
      else v.src = URL.createObjectURL(ms);
      stage(v);
      await new Promise((ok) => ms.addEventListener('sourceopen', ok, { once: true }));
      const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01F"');
      for (const c of r._chunks) {
        if (!c.size) continue;
        sb.appendBuffer(c.buf);
        await new Promise((ok, ko) => {
          sb.addEventListener('updateend', ok, { once: true });
          sb.addEventListener('error', ko, { once: true });
        });
      }
      const b = sb.buffered;
      const start = b.length ? b.start(0) : 0;
      v.currentTime = start + atS;
      await new Promise((ok) => v.addEventListener('seeked', ok, { once: true }));
      await sleep(500);
      label(`${tag}\nbuffered ${start.toFixed(2)}-${b.length ? b.end(b.length - 1).toFixed(2) : '?'} s, at ${v.currentTime.toFixed(2)}`);
      return { at: v.currentTime, vw: v.videoWidth, vh: v.videoHeight };
    }
    // WebCodecs: decode from the keyframe at or before atS, up to 15 frames past it (a P frame).
    const ch = r._chunks;
    let k = 0;
    for (let j = 0; j < ch.length; j++) if (ch[j].type === 'key' && ch[j].ts <= atS * 1e6) k = j;
    const cv = document.createElement('canvas');
    cv.width = r.w;
    cv.height = r.h;
    const ctx = cv.getContext('2d');
    let last = null;
    const dec = new VideoDecoder({
      output: (f) => {
        ctx.drawImage(f, 0, 0, r.w, r.h);
        last = f.timestamp;
        f.close();
      },
      error: (e) => err(e),
    });
    dec.configure(r._decoderConfig);
    for (let j = k; j < Math.min(ch.length, k + 16); j++)
      dec.decode(new EncodedVideoChunk({ type: ch[j].type, timestamp: ch[j].ts, data: ch[j].data }));
    await dec.flush();
    dec.close();
    stage(cv);
    label(`${tag}\nframe ts ${(last / 1e6).toFixed(2)} s (keyframe + 15)`);
    return { at: last / 1e6 };
  };
})();
