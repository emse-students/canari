/**
 * THE iPHONE'S WDA-ONLY OBSERVABLES (O3, O6-O11 of docs/wiki/cross-client-ios.md) - every decision
 * pinned over a SCRIPTED iPhone: screens of accessibility elements, taps that move between them,
 * switches that flip or stay stuck. No phone, no WDA, no names.mjs.
 *
 * Each observable is asserted on the property that makes it EVIDENCE rather than a gesture:
 *
 *   O3   airplane mode leaves BOTH radios read back off (iOS can restore Wi-Fi inside airplane mode);
 *        a switch that did not flip THROWS; the link conditioner's switch is read back
 *   O6   the force-quit is the SWITCHER gesture, never `terminate`, and it is PROVEN dead; the home
 *        screen's icon of the same name is not mistaken for the card
 *   O7   Settings is walked from its ROOT, on iOS 18 (Apps > Canari) and before it (Canari)
 *   O8   a reboot must be SEEN going down - a restart that was not taken is not a fast reboot
 *   O9   an uninstall is proven by asking the device; the sign-in sheet's password goes through
 *        STDIN and never into an argv; the app's own text field is never taken for the IdP form
 *   O10  a deep link opens with NOTHING launched first, so a dead app is a COLD start
 *   O11  a notification action is a LONG PRESS then the action named by the app's own strings
 *
 * The labels and shapes are the EXPECTED ones; the first live session re-pins them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.IOS_SYSLOG_FILE = join(mkdtempSync(join(tmpdir(), 'ios-observables-selftest-')), 'syslog.log');
process.env.IOS_UDID = 'UDID-I1';

const ios = await import('../phone-ios.mjs');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}   ${label}${ok || !detail ? '' : ` - ${detail}`}`);
  if (!ok) failures++;
}
const fails = async (fn, re) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test(e.message) ? true : e.message;
  }
};

const H = 844;
const row = (y) => ({ x: 0, y, width: 390, height: 44 });
/** One accessibility element; `go` names the screen a tap moves to, `toggle` makes it a switch. */
const el = (label, type, rect, extra = {}) => ({ label, type: `XCUIElementType${type}`, rect, text: label, value: null, ...extra });

/**
 * A scripted iPhone. `screens` maps a name to its elements; `scroll` lists the screens a swipe-up
 * scrolls (their elements move up 400 pt). Records every ios.mjs call and every stdin text.
 */
function device({ screens, start, state = 4, installed = true, pymd = () => '' } = {}) {
  const s = { screens, screen: start, state, calls: [], stdin: [], clock: 0, installed, signInstalls: 0 };
  const visible = () =>
    (s.screens[s.screen] ?? []).map((e) => {
      const { go: _g, toggle: _t, stuck: _s, onTap: _o, ...rest } = e;
      return { ...rest, text: [e.label, e.value].filter((v) => v !== null && v !== undefined).join(' | ') };
    });
  const hit = (x, y) =>
    [...(s.screens[s.screen] ?? [])].reverse().find((e) => x >= e.rect.x && x <= e.rect.x + e.rect.width && y >= e.rect.y && y <= e.rect.y + e.rect.height);
  const restore = ios.__setIo({
    ios(args) {
      s.calls.push(args.join(' '));
      const [cmd, ...a] = args.map(String);
      switch (cmd) {
        case 'size':
          return JSON.stringify({ width: 390, height: H });
        case 'flat':
          return JSON.stringify(visible());
        case 'state':
          return String(s.state);
        case 'active':
          return JSON.stringify(s.state === 4 ? { bundleId: ios.PKG, pid: 4242 } : { bundleId: 'com.apple.springboard', pid: 1 });
        case 'tap': {
          const [x, y] = a[0].split(',').map(Number);
          const e = hit(x, y);
          if (!e) return '';
          if (e.toggle && !e.stuck) e.value = e.value === '1' ? '0' : '1';
          if (e.go) s.screen = e.go;
          e.onTap?.(s);
          return '';
        }
        case 'swipe': {
          const [x1, y1, , y2] = a.map(Number);
          if (y1 <= 5) s.screen = x1 > 390 / 2 ? 'control' : (s.centre ?? s.screen);
          else if (y2 < y1 && s.scroll?.includes(s.screen)) for (const e of s.screens[s.screen]) e.rect = { ...e.rect, y: e.rect.y - 400 };
          else if (y1 >= H - 5) s.screen = s.under ?? s.screen;
          return '';
        }
        case 'gesture': {
          const g = JSON.parse(a[0]);
          if (g[0].y >= H - 5) s.screen = s.switcher ?? 'home';
          else if (s.screen === 'switcher' && g[2].y < 50 && !s.flickMisses) s.state = 1;
          return '';
        }
        case 'long':
          s.screen = s.expanded ?? s.screen;
          return '';
        case 'url':
          s.onUrl?.(s);
          return '';
        case 'terminate':
          return '';
        case 'launch':
          if (a[0] === 'com.apple.Preferences') s.screen = 'root';
          else s.state = 4;
          return '';
        case 'button':
          s.screen = 'home';
          if (s.state === 4) s.state = 2;
          return '';
        default:
          return '';
      }
    },
    typeStdin: (text) => {
      s.stdin.push(text);
      s.onType?.(s, text);
    },
    signInstall: () => {
      s.signInstalls++;
      s.installed = s.installWorks !== false;
    },
    pymd: (args) => pymd(s, args),
    now: () => s.clock,
    sleepSync: () => {},
    sleep: async (ms) => {
      s.clock += ms;
      s.onTick?.(s);
    },
  });
  return { s, restore };
}

// --- O3 - offline through Control Center ---------------------------------------------------------------

{
  const { s, restore } = device({
    start: 'app',
    screens: {
      app: [],
      control: [el('Mode Avion', 'Switch', { x: 20, y: 80, width: 60, height: 60 }, { value: '0', toggle: true }), el('Wi-Fi', 'Switch', { x: 90, y: 80, width: 60, height: 60 }, { value: '1', toggle: true })],
    },
  });
  s.under = 'app';
  const r = ios.setAirplaneMode(true);
  check('O3 offline: airplane read back ON', r.airplane.before === false && r.airplane.after === true, JSON.stringify(r));
  check('O3 offline: Wi-Fi read back OFF too (iOS restores a Wi-Fi turned on in airplane mode)', r.wifi.before === true && r.wifi.after === false);
  check('O3: Control Center from the top-RIGHT edge, closed afterwards', s.calls[1].startsWith('swipe 351 2') && s.screen === 'app', s.calls.join(' ; '));
  s.screens.control[0].value = '1';
  s.screens.control[1].value = '1';
  const again = ios.setAirplaneMode(true);
  check('O3: an airplane already on is not tapped (no toggle back)', again.airplane.before === true && again.wifi.after === false);
  s.screens.control[0].value = '0';
  s.screens.control[0].stuck = true;
  check('O3: a switch that did not flip THROWS, never reports offline', (await fails(() => ios.setAirplaneMode(true), /reads false after the tap - wanted true/)) === true);
  s.screens.control = [];
  check('O3: Control Center with no airplane control names what it looked for', (await fails(() => ios.setAirplaneMode(true), /Mode Avion \/ Airplane Mode/)) === true);
  restore();
}
{
  const enable = el('Enable', 'Switch', row(100), { value: '0', toggle: true });
  const { s, restore } = device({
    start: 'app',
    screens: {
      root: [el('Général', 'Cell', row(200)), el('Développeur', 'Cell', row(1100), { go: 'dev' })],
      dev: [el('Network Link Conditioner', 'Cell', row(300), { go: 'nlc' })],
      nlc: [enable, el('3G', 'Cell', row(400))],
    },
  });
  s.scroll = ['root'];
  const r = ios.setLinkConditioner('3G');
  check('O3 throttle: Settings from its ROOT, scrolled to Developer, NLC enabled and read back', r.enable.after === true && r.profile === '3G', JSON.stringify(r));
  check('O3 throttle: Settings was ENDED first, so the path starts at the root', s.calls.indexOf('terminate com.apple.Preferences') < s.calls.indexOf('launch com.apple.Preferences'));
  check('O3 throttle: the profile row was tapped', s.calls.includes('tap 195,422'));
  const off = ios.setLinkConditioner(null);
  check('O3 throttle off: the switch read back OFF', off.enable.after === false && off.profile === null);
  restore();
}

// --- O6 - the user's force-quit ---------------------------------------------------------------------

{
  const { s, restore } = device({
    start: 'app',
    screens: { app: [], switcher: [el('Canari', 'Other', { x: 60, y: 150, width: 270, height: 560 })], home: [] },
  });
  s.switcher = 'switcher';
  const r = await ios.forceQuit();
  check('O6: the card is flicked and the app PROVEN dead', s.state === 1 && r.stateBefore === 'IOS_FOREGROUND', JSON.stringify(r));
  check('O6: the switcher gesture, never `terminate` (that is an OS death, not the user)', !s.calls.some((c) => c.startsWith('terminate')) && s.calls.filter((c) => c.startsWith('gesture')).length === 2);
  check('O6: the flick starts on the card', JSON.parse(s.calls.filter((c) => c.startsWith('gesture'))[1].slice(8))[0].y === 430);
  restore();
}
{
  const { s, restore } = device({ start: 'app', screens: { app: [], home: [el('Canari', 'Icon', { x: 20, y: 600, width: 64, height: 64 })] } });
  check('O6: the home screen icon is NOT a card - the switcher did not open, and it says so', (await fails(() => ios.forceQuit(), /shows no Canari card/)) === true);
  check('O6: nothing was flicked', s.state === 4 || s.state === 2);
  restore();
}
{
  const { s, restore } = device({ start: 'app', screens: { app: [], switcher: [el('Canari', 'Other', { x: 60, y: 150, width: 270, height: 560 })] } });
  s.switcher = 'switcher';
  s.flickMisses = true;
  check('O6: a flick that missed THROWS rather than reading as a quit', (await fails(() => ios.forceQuit(2_000), /still reads/)) === true);
  restore();
}
{
  const { restore } = device({ start: 'app', state: 1, screens: { app: [] } });
  check('O6: a dead app has no card to flick, and says so', (await fails(() => ios.forceQuit(), /not running/)) === true);
  restore();
}

// --- O7 - Settings ----------------------------------------------------------------------------------

const notifScreens = (root) => ({
  root,
  apps: [el('Calendrier', 'Cell', row(200)), el('Canari', 'Cell', row(260), { go: 'canari' })],
  canari: [el('Notifications', 'Cell', row(200), { go: 'notif' })],
  notif: [el('Autoriser les notifications', 'Switch', row(120), { value: '1', toggle: true })],
});
{
  const { s, restore } = device({ start: 'app', screens: notifScreens([el('Général', 'Cell', row(200)), el('Apps', 'Cell', row(900), { go: 'apps' })]) });
  s.scroll = ['root'];
  const r = ios.setNotificationsAllowed(false);
  check('O7 iOS 18: Settings > Apps > Canari > Notifications', JSON.stringify(r.path) === '["Apps","Canari","Notifications"]', JSON.stringify(r));
  check('O7: the permission switch read back OFF', r.before === true && r.after === false);
  check('O7: Settings is left (home) so the next step starts from a known screen', s.screen === 'home');
  restore();
}
{
  const { restore } = device({ start: 'app', screens: notifScreens([el('Général', 'Cell', row(200)), el('Canari', 'Cell', row(300), { go: 'canari' })]) });
  const r = ios.setNotificationsAllowed(true);
  check('O7 iOS 17: Canari straight off the root', JSON.stringify(r.path) === '["Canari","Notifications"]' && r.after === true, JSON.stringify(r));
  restore();
}
{
  const { restore } = device({ start: 'app', screens: { root: [el('Général', 'Cell', row(200))] } });
  check('O7: an app missing from Settings is named after the scrolls, not tapped blind', (await fails(() => ios.setNotificationsAllowed(true), /nothing labelled Canari \/ Apps after 10 scrolls/)) === true);
  restore();
}

// --- O8 - reboot ------------------------------------------------------------------------------------

{
  const usbmux = (s) => JSON.stringify(s.listed ? [{ Identifier: 'UDID-I1' }] : []);
  const { s, restore } = device({
    start: 'app',
    screens: { app: [] },
    pymd: (st, args) => {
      if (args[0] === 'usbmux') return usbmux(st);
      if (args[0] === 'diagnostics') st.restartAt = st.clock;
      return '';
    },
  });
  s.listed = true;
  s.onTick = (st) => {
    if (st.restartAt === undefined) return;
    const since = st.clock - st.restartAt;
    st.listed = since < 4_000 || since >= 40_000;
  };
  const wdaDown = ios.__setIo({ ios: () => { throw new Error('WDA down'); } });
  const r = await ios.reboot();
  wdaDown();
  check('O8: seen going DOWN, then back', r.downInMs >= 4_000 && r.backInMs >= 40_000 && r.backInMs > r.downInMs, JSON.stringify(r));
  check('O8: WDA is reported down after it, and the first unlock is a human\'s', r.wda === 'down' && /human passcode/.test(r.owed));
  restore();
}
{
  const { restore } = device({ start: 'app', screens: { app: [] }, pymd: (st, args) => (args[0] === 'usbmux' ? JSON.stringify([{ Identifier: 'UDID-I1' }]) : '') });
  check('O8: a restart that was never taken is REFUSED, not a fast reboot', (await fails(() => ios.reboot({ downTimeoutMs: 10_000 }), /was not taken/)) === true);
  restore();
}

// --- O9 - a fresh device ------------------------------------------------------------------------------

{
  const apps = (st) => (st.installed ? { 'fr.emse.canari': { CFBundleIdentifier: 'fr.emse.canari' }, 'com.x': {} } : { 'com.x': {} });
  const { s, restore } = device({
    start: 'app',
    screens: { app: [] },
    pymd: (st, args) => {
      if (args[0] === 'apps' && args[1] === 'list') return JSON.stringify(apps(st));
      if (args[0] === 'apps' && args[1] === 'uninstall') st.installed = st.uninstallWorks === false;
      return '';
    },
  });
  check('O9: installed, asked of the device (a dict)', ios.isInstalled() === true);
  const r = ios.freshInstall('bench.ipa');
  check('O9: uninstalled (proven) then signed + installed (proven)', r.wasInstalled === true && r.installed === true && s.signInstalls === 1, JSON.stringify(r));
  s.uninstallWorks = false;
  check('O9: an uninstall that left the app THROWS', (await fails(() => ios.uninstall(), /still listed/)) === true);
  s.uninstallWorks = true;
  s.installWorks = false;
  check('O9: an install that exited 0 and installed nothing THROWS', (await fails(() => ios.freshInstall('bench.ipa'), /is not installed/)) === true);
  restore();
}
{
  const { restore } = device({ start: 'app', screens: { app: [] }, pymd: () => JSON.stringify([{ CFBundleIdentifier: 'fr.emse.canari' }]) });
  check('O9: installed, asked of the device (a list)', ios.isInstalled() === true);
  restore();
}
{
  const HOSTS = ['auth.canari-emse.fr', 'cas.emse.fr'];
  const appField = el('Rechercher', 'TextField', row(60));
  check('O9: the app\'s own text field is NOT the IdP form', ios.signInStage([appField], HOSTS) === null);
  check('O9: "Continuer" outside an alert is the app\'s word, not the consent', ios.signInStage([el('Continuer', 'Button', row(300))], HOSTS) === null);
  const alert = [el('« Canari » souhaite utiliser « canari-emse.fr » pour se connecter', 'Alert', row(300)), el('Continuer', 'Button', row(400))];
  check('O9: the consent alert', ios.signInStage(alert, HOSTS) === 'consent');
  const bar = el('auth.canari-emse.fr', 'StaticText', row(50));
  check('O9: the identifier stage, in the sheet', ios.signInStage([bar, el('', 'TextField', row(200))], HOSTS) === 'identifier');
  check('O9: the password stage, in the sheet', ios.signInStage([bar, el('', 'SecureTextField', row(260))], HOSTS) === 'password');

  const creds = { username: 'canari-test-alpha', password: 's3cr3t-Pw' };
  const { s, restore } = device({
    start: 'consent',
    screens: {
      consent: [alert[0], { ...alert[1], go: 'uid' }],
      uid: [bar, el('Nom d\'utilisateur', 'TextField', row(200), { value: 'Nom d\'utilisateur' })],
      pwd: [bar, el('Mot de passe', 'SecureTextField', row(260), { value: '' })],
      app: [appField],
    },
  });
  s.onType = (st, text) => {
    if (st.screen === 'uid' && text.endsWith('\n')) st.screen = 'pwd';
    else if (st.screen === 'pwd' && text.endsWith('\n')) st.screen = 'app';
  };
  const r = await ios.signInThroughSheet(creds, { hosts: HOSTS, settled: async () => s.screen === 'app' });
  check('O9 sign-in: consent, identifier, password - in that order', JSON.stringify(r.stages) === '["consent","identifier","password"]', JSON.stringify(r));
  check('O9 sign-in: each stage ended with RETURN, never the form\'s button', s.stdin.every((t) => t.endsWith('\n')) && s.stdin.length === 2);
  check('O9 sign-in: the field is cleared first (its placeholder deleted, harmless)', s.stdin[0].startsWith('\b'.repeat("Nom d'utilisateur".length)) && s.stdin[0].endsWith('canari-test-alpha\n'));
  check('O9 sign-in: the PASSWORD never reached an argv', !s.calls.some((c) => c.includes(creds.password)) && s.stdin[1].endsWith('s3cr3t-Pw\n'));
  check('O9 sign-in: the app\'s own search field, once back, was left alone', s.stdin.length === 2);
  restore();
}
{
  const HOSTS = ['auth.canari-emse.fr'];
  const alert = [el('« Canari » souhaite utiliser…', 'Alert', row(300)), el('Continuer', 'Button', row(400), { go: 'app' })];
  const { s, restore } = device({ start: 'consent', screens: { consent: alert, app: [] } });
  const r = await ios.signInThroughSheet({ username: 'u', password: 'p' }, { hosts: HOSTS });
  check('O9: an IdP that kept its session closes the sheet after the consent - nothing typed', JSON.stringify(r.stages) === '["consent"]' && s.stdin.length === 0, JSON.stringify(r));
  restore();
}
{
  const HOSTS = ['auth.canari-emse.fr'];
  const bar = el('auth.canari-emse.fr', 'StaticText', row(50));
  const { s, restore } = device({ start: 'uid', screens: { uid: [bar, el('', 'TextField', row(200))] } });
  check(
    'O9: a stage the IdP keeps refusing THROWS - the credential is not retyped',
    (await fails(() => ios.signInThroughSheet({ username: 'u', password: 'p' }, { hosts: HOSTS, timeoutMs: 10_000 }), /identifier stage was answered and is still on screen/)) === true,
  );
  check('O9: typed once, not once per poll', s.stdin.length === 1);
  restore();
}

// --- O10 - a cold deep link ---------------------------------------------------------------------------

{
  const { s, restore } = device({
    start: 'home',
    state: 1,
    screens: { home: [], ask: [el('Ouvrir dans « Canari » ?', 'Alert', row(300)), el('Ouvrir', 'Button', row(400), { go: 'app', onTap: (st) => (st.state = 4) })], app: [] },
  });
  s.onUrl = (st) => (st.screen = 'ask');
  const r = await ios.openDeepLink('fr.emse.canari://chat/abc');
  check('O10: a dead app is a COLD start, the confirmation answered, the app in front', r.cold === true && r.confirmed === true && s.state === 4, JSON.stringify(r));
  check('O10: NOTHING was launched before the link (a launch would make it warm)', !s.calls.some((c) => c.startsWith('launch')) && s.calls.some((c) => c === 'url fr.emse.canari://chat/abc'));
  restore();
}
{
  const { restore } = device({ start: 'home', state: 1, screens: { home: [] } });
  check('O10: a link that never brings the app forward THROWS', (await fails(() => ios.openDeepLink('fr.emse.canari://chat/x', 3_000), /never came to the front/)) === true);
  restore();
}

// --- O11 - a notification's actions -------------------------------------------------------------------

{
  const t = ios.notificationActionTitles();
  check('O11: the titles come from the app\'s own Localizable.strings, both languages', t.reply.includes('Répondre') && t.reply.includes('Reply') && t.mark_read.includes('Marquer comme lu') && t.send.includes('Envoyer'), JSON.stringify(t));
  const p = ios.parseStrings('/* c */\n"a.b" = "x \\"y\\"";\n  "c" = "d";\n');
  check('O11: .strings parsing keeps escaped quotes', p.get('a.b') === 'x \\"y\\"' && p.get('c') === 'd');
}
const NOTE = { type: 'XCUIElementTypeButton', label: 'Canari, Paul Peer, hello N11-REPLY, maintenant', text: 'Canari, Paul Peer, hello N11-REPLY, maintenant', rect: { x: 8, y: 220, width: 374, height: 80 }, value: null };
{
  const { s, restore } = device({
    start: 'centre',
    state: 1,
    screens: {
      centre: [NOTE],
      expanded: [NOTE, el('Répondre', 'Button', row(500), { go: 'reply' }), el('Marquer comme lu', 'Button', row(560), { go: 'centre' })],
      reply: [el('Envoyer', 'Button', row(420), { go: 'centre' })],
    },
  });
  s.centre = 'centre';
  s.expanded = 'expanded';
  const r = await ios.notificationAction('N11-REPLY', 'reply', { text: 'ok from the shade' });
  check('O11 reply: long press, Répondre, typed, Envoyer - and the action is gone', r.ok === true && r.found === true, JSON.stringify(r));
  check('O11: a LONG press on the notification, at its centre', s.calls.includes('long 195 260 900'));
  check('O11: the reply text went through stdin', JSON.stringify(s.stdin) === '["ok from the shade"]');
  check('O11: the app was not launched to do it (it may be dead - NOTIF-6)', !s.calls.some((c) => c.startsWith('launch')) && s.state === 1);
  s.screen = 'centre';
  const m = await ios.notificationAction('N11-REPLY', 'mark_read');
  check('O11 mark read: taken', m.ok === true, JSON.stringify(m));
  s.screens.expanded = [NOTE];
  s.screen = 'centre';
  const none = await ios.notificationAction('N11-REPLY', 'mark_read');
  check('O11: no action after the long press is named, found:true ok:false', none.ok === false && none.found === true && /Marquer comme lu \/ Mark as read/.test(none.why), JSON.stringify(none));
  s.screen = 'centre';
  const absent = await ios.notificationAction('ABSENT', 'mark_read');
  check('O11: no such notification is found:false - the row\'s answer', absent.ok === false && absent.found === false);
  check('O11: an unknown action is refused', (await fails(() => ios.notificationAction('x', 'archive'), /unknown action/)) === true);
  restore();
}

console.log(failures ? `\n${failures} FAILED` : '\nios-observables selftest OK');
process.exit(failures ? 1 : 0);
