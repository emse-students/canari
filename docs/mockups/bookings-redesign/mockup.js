/* Bookings redesign mockups (D44-D54) - STATIC, NOT SHIPPED CODE.
   One shared script so every screen draws the same shell, the same week grid and the same
   painter. Query parameters: ?theme=dark, ?notes=0 (hide the annotations), plus each page's own. */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  if (params.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
  if (params.get('notes') === '0') document.documentElement.classList.add('no-notes');

  const HOUR_PX = 64;

  /** "18:00" from minutes since midnight; 1440 reads "24:00". */
  function fmt(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  /** "1 h 30" / "30 min" / "2 h". */
  function dur(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return m + ' min';
    return m ? h + ' h ' + String(m).padStart(2, '0') : h + ' h';
  }

  function icon(name, cls) {
    return '<i data-lucide="' + name + '"' + (cls ? ' class="' + cls + '"' : '') + '></i>';
  }

  function paintIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  /** Wraps #page in the app shell: top bar, desktop rail, phone bottom bar (D37: no new tab). */
  function shell(opts) {
    const page = document.getElementById('page');
    const rail = [
      ['newspaper', 'Fil', 'posts'],
      ['users', 'Communautés', 'communities'],
      ['message-circle', 'Discussions', 'chat'],
      ['calendar-days', 'Agenda', 'calendar'],
      ['calendar-clock', 'Réservations', 'bookings'],
      ['layout-dashboard', 'Tableau de bord', 'dashboard'],
    ];
    const bottom = [
      ['newspaper', 'Fil', 'posts'],
      ['users', 'Communautés', 'communities'],
      ['message-circle', 'Discussions', 'chat'],
      ['layout-dashboard', 'Tableau de bord', 'dashboard'],
    ];
    const link = (it) =>
      '<a href="#" class="' +
      (it[2] === opts.active ? 'active' : '') +
      '">' +
      icon(it[0]) +
      '<span>' +
      it[1] +
      '</span></a>';
    const top =
      '<header class="topbar"><div class="brand"><span class="brand-dot">' +
      icon('bird') +
      '</span>Canari</div><div class="grow"></div>' +
      '<button class="btn icon ghost" aria-label="Notifications">' +
      icon('bell') +
      '</button><span class="avatar">AB</span></header>';
    const wrap = document.createElement('div');
    wrap.innerHTML =
      top +
      '<div class="shell"><nav class="rail">' +
      rail.map(link).join('') +
      '</nav><div class="main"></div></div><nav class="bottomnav">' +
      bottom.map(link).join('') +
      '</nav>';
    page.parentNode.insertBefore(wrap, page);
    wrap.querySelector('.main').appendChild(page);
    while (wrap.firstChild) wrap.parentNode.insertBefore(wrap.firstChild, wrap);
    wrap.remove();
  }

  /* ---------------------------------------------------------------- sheets */
  function openSheet(id) {
    document.getElementById(id).classList.add('open');
    document.querySelector('.scrim').classList.add('open');
  }
  function closeSheets() {
    document.querySelectorAll('.sheet.open, .scrim.open').forEach((el) => el.classList.remove('open'));
    document.dispatchEvent(new CustomEvent('mk-sheet-closed'));
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target.classList.contains('scrim')) closeSheets();
    const opener = e.target.closest('[data-open]');
    if (opener) openSheet(opener.dataset.open);
  });

  /* ---------------------------------------------------------------- the week grid */
  /**
   * cfg.days: [{ label, num, long, open: [[s, e]], closedLabel, items: [{ s, e, kind, title, sub }],
   *              today, past }]
   * cfg.startMin / cfg.endMin: the hours drawn. cfg.step, cfg.maxSteps (book mode only).
   * cfg.mode: 'book' (drag picks a duration), 'block' (organiser: drag blocks), 'slots' (tap a slot).
   * cfg.nowMin: the clock on the `today` column. cfg.onSelect(day, s, e), cfg.onItem(item, day).
   */
  function weekGrid(host, cfg) {
    const px = (min) => ((min - cfg.startMin) * HOUR_PX) / 60;
    const height = px(cfg.endMin);
    const cols = cfg.days
      .map((d) => (d.open.length || !cfg.narrowClosed ? 'minmax(0, 1fr)' : '32px'))
      .join(' ');
    const tmpl = 'var(--gutter) ' + cols;

    let head = '<div class="wk-head" style="grid-template-columns:' + tmpl + '"><div></div>';
    cfg.days.forEach((d) => {
      const closed = !d.open.length;
      head +=
        '<div class="d' +
        (d.today ? ' today' : '') +
        (closed ? ' closed' : '') +
        '">' +
        (closed && cfg.narrowClosed ? d.label.charAt(0).toUpperCase() : d.label) +
        '<b>' +
        d.num +
        '</b></div>';
    });
    head += '</div>';

    let gutter = '<div class="wk-gutter" style="height:' + height + 'px">';
    for (let m = cfg.startMin; m <= cfg.endMin; m += 30) {
      if (m === cfg.startMin) continue;
      gutter +=
        '<span class="' + (m % 60 ? '' : 'h') + '" style="top:' + px(m) + 'px">' + fmt(m) + '</span>';
    }
    gutter += '</div>';

    let body = '<div class="wk-body" style="grid-template-columns:' + tmpl + '">' + gutter;
    cfg.days.forEach((d, i) => {
      body += '<div class="wk-col" data-day="' + i + '" style="height:' + height + 'px">';
      d.open.forEach((r) => {
        body +=
          '<div class="open" data-s="' +
          r[0] +
          '" data-e="' +
          r[1] +
          '" style="top:' +
          px(r[0]) +
          'px;height:' +
          (px(r[1]) - px(r[0])) +
          'px;background-position-y:' +
          -px(r[0]) +
          'px"></div>';
      });
      if (!d.open.length && d.closedLabel)
        body += '<div class="closed-label">' + d.closedLabel + '</div>';
      (d.items || []).forEach((it, j) => {
        const h = px(it.e) - px(it.s);
        body +=
          '<div class="wk-item ' +
          it.kind +
          '" data-item="' +
          j +
          '" style="top:' +
          (px(it.s) + 1) +
          'px;height:' +
          (h - 2) +
          'px">' +
          '<b>' +
          (it.title || '') +
          '</b>' +
          (h > 34 ? '<span>' + fmt(it.s) + ' – ' + fmt(it.e) + (it.sub ? ' · ' + it.sub : '') + '</span>' : '') +
          '</div>';
      });
      if (d.past) body += '<div class="past" style="height:' + height + 'px"></div>';
      if (d.today && cfg.nowMin) {
        body += '<div class="past" style="height:' + px(cfg.nowMin) + 'px"></div>';
        body += '<div class="nowline" style="top:' + px(cfg.nowMin) + 'px"></div>';
      }
      body += '<div class="wk-ghost"></div></div>';
    });
    body += '</div>';

    host.innerHTML = '<div class="wk' + (cfg.hideHead ? ' nohead' : '') + '"><div class="wk-scroll">' + head + body + '</div></div>';
    let chip = document.querySelector('.dragchip');
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'dragchip';
      document.body.appendChild(chip);
    }

    const scroller = host.querySelector('.wk-scroll');
    if (cfg.scrollTo) scroller.scrollTop = px(cfg.scrollTo);

    /* The free run from an anchor towards a target, one step at a time: it stops at the first step
       that is outside the open range, under an item, in the past, or past the step ceiling. */
    function run(dayIdx, anchor, target) {
      const d = cfg.days[dayIdx];
      const range = d.open.find((r) => anchor >= r[0] && anchor < r[1]);
      if (!range) return null;
      const limit = cfg.mode === 'book' ? cfg.maxSteps : Infinity;
      const free = (s) =>
        s >= range[0] &&
        s + cfg.step <= range[1] &&
        !(d.items || []).some((it) => it.s < s + cfg.step && it.e > s) &&
        !d.past &&
        !(d.today && cfg.nowMin && s < cfg.nowMin);
      if (!free(anchor)) return null;
      let s = anchor;
      let e = anchor + cfg.step;
      let count = 1;
      if (target >= anchor) {
        while (count < limit && e < target + cfg.step && free(e)) {
          e += cfg.step;
          count++;
        }
      } else {
        while (count < limit && s > target && free(s - cfg.step)) {
          s -= cfg.step;
          count++;
        }
      }
      return [s, e];
    }

    function minuteAt(col, clientY) {
      const rect = col.getBoundingClientRect();
      const raw = cfg.startMin + ((clientY - rect.top) * 60) / HOUR_PX;
      return cfg.startMin + Math.floor((raw - cfg.startMin) / cfg.step) * cfg.step;
    }

    let drag = null;
    let holdTimer = null;

    function showSel(col, r) {
      let sel = col.querySelector('.wk-sel');
      if (!sel) {
        sel = document.createElement('div');
        sel.className = 'wk-sel' + (cfg.mode === 'block' ? ' block' : '');
        col.appendChild(sel);
      }
      sel.style.top = px(r[0]) + 'px';
      sel.style.height = px(r[1]) - px(r[0]) + 'px';
      sel.textContent = fmt(r[0]) + ' – ' + fmt(r[1]);
      const d = cfg.days[+col.dataset.day];
      chip.style.display = 'flex';
      chip.innerHTML =
        (cfg.mode === 'block' ? icon('ban') + 'Bloquer · ' : '') +
        d.long +
        ' · ' +
        fmt(r[0]) +
        ' – ' +
        fmt(r[1]) +
        ' <span style="opacity:.7">(' +
        dur(r[1] - r[0]) +
        ')</span>';
      paintIcons();
    }

    function clearSel() {
      host.querySelectorAll('.wk-sel').forEach((el) => el.remove());
      chip.style.display = 'none';
    }
    document.addEventListener('mk-sheet-closed', clearSel);

    function begin(col, ev) {
      const anchor = minuteAt(col, ev.clientY);
      const r = run(+col.dataset.day, anchor, anchor);
      if (!r) return;
      clearSel();
      drag = { col, anchor, r };
      showSel(col, r);
    }

    host.addEventListener('pointerdown', (ev) => {
      const item = ev.target.closest('.wk-item');
      if (item) {
        const day = +item.parentNode.dataset.day;
        if (cfg.onItem) cfg.onItem(cfg.days[day].items[+item.dataset.item], day);
        return;
      }
      if (cfg.mode === 'slots') return;
      const col = ev.target.closest('.wk-col');
      if (!col || !ev.target.closest('.open')) return;
      if (ev.pointerType === 'touch') {
        /* A finger must hold 250 ms: a quicker move is the page scrolling (as shipped in WP-B5). */
        const y0 = ev.clientY;
        holdTimer = setTimeout(() => {
          holdTimer = null;
          begin(col, ev);
          if (drag) col.setPointerCapture(ev.pointerId);
        }, 250);
        const cancel = (m) => {
          if (Math.abs(m.clientY - y0) > 8 && holdTimer) {
            clearTimeout(holdTimer);
            holdTimer = null;
          }
        };
        col.addEventListener('pointermove', cancel, { once: false });
        return;
      }
      ev.preventDefault();
      begin(col, ev);
      if (drag) col.setPointerCapture(ev.pointerId);
    });

    host.addEventListener('pointermove', (ev) => {
      const col = ev.target.closest('.wk-col');
      if (drag) {
        const r = run(+drag.col.dataset.day, drag.anchor, minuteAt(drag.col, ev.clientY));
        if (r) {
          drag.r = r;
          showSel(drag.col, r);
        }
        return;
      }
      host.querySelectorAll('.wk-ghost').forEach((g) => (g.style.display = 'none'));
      if (ev.pointerType !== 'mouse' || cfg.mode === 'slots' || !col || !ev.target.closest('.open'))
        return;
      const m = minuteAt(col, ev.clientY);
      if (!run(+col.dataset.day, m, m)) return;
      const g = col.querySelector('.wk-ghost');
      g.style.display = 'block';
      g.style.top = px(m) + 'px';
      g.style.height = px(m + cfg.step) - px(m) + 'px';
      g.textContent = '+ ' + fmt(m);
    });

    host.addEventListener('pointerup', () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (!drag) return;
      const d = drag;
      drag = null;
      chip.style.display = 'none';
      if (cfg.onSelect) cfg.onSelect(+d.col.dataset.day, d.r[0], d.r[1]);
    });
    host.addEventListener('pointerleave', () =>
      host.querySelectorAll('.wk-ghost').forEach((g) => (g.style.display = 'none'))
    );

    return { clearSel };
  }

  /* ---------------------------------------------------------------- the painter (D49) */
  const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const TEMPLATES = {
    always: () => {
      const s = new Set();
      for (let d = 0; d < 7; d++) for (let r = 0; r < 48; r++) s.add(d + ':' + r);
      return s;
    },
    weekdays: () => {
      const s = new Set();
      for (let d = 0; d < 5; d++) for (let r = 16; r < 40; r++) s.add(d + ':' + r);
      return s;
    },
    event: () => new Set(),
    empty: () => new Set(),
  };

  /** A week of 48 half-hours per day; press and drag paints a rectangle, starting on an open cell
      erases instead (one gesture, no brush to pick). */
  function painter(host, opts) {
    let on = opts.initial || new Set();
    const rows = 48;
    const from = opts.fromRow || 0;
    const to = opts.toRow || rows;
    let html = '<div class="paint"><div class="paint-grid"><div class="ph"></div>';
    DAYS.forEach((d) => (html += '<div class="ph">' + d + '</div>'));
    for (let r = from; r < to; r++) {
      html +=
        '<div class="pt' + (r % 2 ? '' : ' h') + '">' + (r % 2 ? '' : fmt(r * 30)) + '</div>';
      for (let d = 0; d < 7; d++)
        html +=
          '<div class="pc' + (r % 2 ? '' : ' hr') + '" data-d="' + d + '" data-r="' + r + '"></div>';
    }
    html += '</div></div>';
    host.innerHTML = html;
    const cells = host.querySelectorAll('.pc');
    const draw = (preview) =>
      cells.forEach((c) => {
        const k = c.dataset.d + ':' + c.dataset.r;
        c.classList.toggle('on', preview ? preview.has(k) : on.has(k));
      });
    draw();

    let g = null;
    const rect = (a, b) => {
      const s = new Set(on);
      for (let d = Math.min(a.d, b.d); d <= Math.max(a.d, b.d); d++)
        for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
          if (g.erase) s.delete(d + ':' + r);
          else s.add(d + ':' + r);
        }
      return s;
    };
    const at = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const c = el && el.closest && el.closest('.pc');
      return c && host.contains(c) ? { d: +c.dataset.d, r: +c.dataset.r } : null;
    };
    host.addEventListener('pointerdown', (ev) => {
      const p = at(ev);
      if (!p) return;
      ev.preventDefault();
      g = { a: p, erase: on.has(p.d + ':' + p.r) };
      g.preview = rect(p, p);
      draw(g.preview);
      host.setPointerCapture(ev.pointerId);
    });
    host.addEventListener('pointermove', (ev) => {
      if (!g) return;
      const p = at(ev);
      if (!p) return;
      g.preview = rect(g.a, p);
      draw(g.preview);
    });
    host.addEventListener('pointerup', () => {
      if (!g) return;
      on = g.preview;
      g = null;
      draw();
      if (opts.onChange) opts.onChange(on);
    });
    return {
      set(s) {
        on = s;
        draw();
        if (opts.onChange) opts.onChange(on);
      },
      get: () => on,
    };
  }

  /** "Lun 08:00 – 20:00" lines from a painted set, the way the summary under the painter reads. */
  function summarize(set) {
    const out = [];
    for (let d = 0; d < 7; d++) {
      const runs = [];
      let start = null;
      for (let r = 0; r <= 48; r++) {
        const isOn = r < 48 && set.has(d + ':' + r);
        if (isOn && start === null) start = r;
        if (!isOn && start !== null) {
          runs.push(fmt(start * 30) + ' – ' + fmt(r * 30));
          start = null;
        }
      }
      out.push({ day: DAYS[d], runs });
    }
    return out;
  }

  window.MK = {
    fmt,
    dur,
    icon,
    paintIcons,
    shell,
    openSheet,
    closeSheets,
    weekGrid,
    painter,
    summarize,
    TEMPLATES,
    DAYS,
    params,
  };
})();
