// Reusable CDP helpers for the user-tutorial screenshots (docs/user-guide/tutoriels): open(port) drives a Chrome
// started with --remote-debugging-port, closes the dev banner before every shot, emulates desktop or mobile,
// and clicks with real pointer events. Run it against dev only, with a scratch profile, never a harness profile.
// reusable CDP flow helpers for the tutorial shots
export async function open(port) {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const t = tabs.find(x => x.type === "page");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) pend.get(m.id)(m.result ?? m.error); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ev = async expression => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const api = {
    send, ev, sleep, ws,
    async view(mobile) {
      await send("Emulation.setDeviceMetricsOverride", mobile ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
    },
    async go(url) { await send("Page.navigate", { url }); await sleep(4500); await api.closeBanner(); },
    async closeBanner() {
      await ev(`(()=>{const el=[...document.querySelectorAll('div,section,aside')].find(d=>d.children.length<=3&&d.textContent.trim().startsWith('Environnement de test')&&d.querySelector('button'));el?.querySelector('button')?.click();return !!el})()`);
      await sleep(300);
    },
    /** real pointer click on the first visible element whose text (or aria-label) contains `text` within `scope` */
    async click(text, scope = "body", sel = "button,a,[role=button],[role=option],[role=tab],label", exact = false, rect = null) {
      const box = await ev(`(()=>{const exact=${exact};const rc=${JSON.stringify(rect)};const root=document.querySelector(${JSON.stringify(scope)});const els=[...root.querySelectorAll(${JSON.stringify(sel)})].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&(!rc||(r.x>=rc[0]&&r.x<=rc[1]&&r.y>=rc[2]))&&((exact?(e.textContent||'').trim()===${JSON.stringify(text)}:(e.textContent||'').trim().includes(${JSON.stringify(text)}))||(e.getAttribute('aria-label')||'').includes(${JSON.stringify(text)}))});const e=els[0];if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      if (!box) throw new Error("click: not found: " + text);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      await sleep(700);
    },
    /** Click inside the open date picker: kind = "day" | "hour" | "minute" | "valider". */
    async pick(kind, text) {
      const box = await ev(`(()=>{const v=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Valider'&&b.getBoundingClientRect().width>0).pop();if(!v)return null;let root=v;while(root&&root.querySelectorAll('button').length<20)root=root.parentElement;if(!root)return null;const bs=[...root.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().width>0);const two=bs.filter(b=>/^[0-9]{2}$/.test(b.textContent.trim())&&!b.className.includes('rounded-full'));const xs=[...new Set(two.map(b=>Math.round(b.getBoundingClientRect().x/10)))].sort((a,c)=>a-c);let e;if(${JSON.stringify(kind)}==='valider')e=v;else if(${JSON.stringify(kind)}==='day')e=bs.find(b=>b.className.includes('rounded-full')&&b.textContent.trim()===${JSON.stringify(text)});else{const col=${JSON.stringify(kind)}==='hour'?xs[0]:xs[xs.length-1];e=two.find(b=>Math.round(b.getBoundingClientRect().x/10)===col&&b.textContent.trim()===${JSON.stringify(text)})}if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      if (!box) throw new Error("pick: not found: " + kind + " " + text);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      await sleep(500);
    },
    async scrollMain(px) { await ev(`[...document.querySelectorAll('*')].forEach(e=>{const o=getComputedStyle(e).overflowY;if((o==='auto'||o==='scroll')&&e.scrollHeight>e.clientHeight+20)e.scrollTop=${px}});window.scrollTo(0,${px})`); await sleep(500); },
    /** Click the button `btn` inside the smallest block that mentions `row`. */
    async clickRow(row, btn) {
      const box = await ev(`(()=>{const c=[...document.querySelectorAll('div,li,article')].filter(d=>d.textContent.includes(${JSON.stringify(row)})&&[...d.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(btn)})).sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];if(!c)return null;const e=[...c.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(btn)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      if (!box) throw new Error("clickRow: not found: " + row + " / " + btn);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      await sleep(900);
    },
    async focus(selector) { await ev(`document.querySelector(${JSON.stringify(selector)}).focus()`); },
    async type(text) { await send("Input.insertText", { text }); await sleep(300); },
    async shot(path) { const s = await send("Page.captureScreenshot", { format: "png" }); await Bun.write(path, Buffer.from(s.data, "base64")); console.log("shot", path); },
    close() { ws.close(); },
  };
  return api;
}
