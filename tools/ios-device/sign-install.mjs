#!/usr/bin/env bun
/**
 * Signs the unsigned bench IPA that `ios.yml` (`local_url`) produced, and installs it on the
 * connected iPhone. Windows cannot compile Apple code, so the BUILD is a macOS runner's; the SIGNING
 * is here because the private key of a development certificate is not handed to CI.
 *
 *   bun tools/ios-device/sign-install.mjs <unsigned.ipa> [--no-install]
 *
 * State lives outside the repository, which is public: `~/.appstoreconnect/ios-dev/`
 *   dev.key, dev.pem          the development certificate's key and certificate
 *   app.mobileprovision       development profile for fr.emse.canari, this phone's UDID inside
 *   nse.mobileprovision       the same for fr.emse.canari.notifications
 *   bin/rcodesign.exe         Apple Codesign, https://github.com/indygreg/apple-platform-rs
 * How those were made, and how the phone is prepared, is
 * docs/wiki/frontend/mobile.md#a-build-for-the-phone-on-the-bench.
 *
 * WHY THE ORDER, THE ENTITLEMENTS AND THE ZIP ARE WHAT THEY ARE (each cost a failed install):
 * - The appex is signed BEFORE the app. Re-signing a signed bundle drops the `Info` slot, which
 *   installd reports as "a signed resource has been added, modified, or deleted".
 * - The entitlements are the REPOSITORY's own files, so the bench app declares what the store app
 *   declares - notably the keychain group shared with the extension, `<team>.group.fr.emse.canari`,
 *   not the profile's `<team>.*`. Three keys are injected because a development profile demands
 *   them (`application-identifier`, the team identifier, `get-task-allow`), and `aps-environment`
 *   becomes `development`, the only value such a profile grants. A DOCTYPE in the file handed to
 *   rcodesign made it embed NOTHING, silently, and installd then refused the app for a missing
 *   `application-identifier` - so the DOCTYPE and the comments are stripped.
 * - The IPA is zipped by Python: installd answered "Could not extract archive" to `tar -a`.
 * - A framework nested inside an appex is sealed as loose files by rcodesign and fails
 *   verification; this app has none, and that is asserted rather than discovered on the phone.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE = join(homedir(), '.appstoreconnect', 'ios-dev');
const HERE = dirname(fileURLToPath(import.meta.url));
const APPLE = resolve(HERE, '../../frontend/src-tauri/gen/apple');
const RCODESIGN = process.env.RCODESIGN || join(STATE, 'bin', 'rcodesign.exe');
const TAR = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

/** Runs a command and returns its stdout, throwing with both streams when it fails. */
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  }
  return r.stdout ?? '';
}

/**
 * The application identifier, team and expiry of a profile. A profile is a CMS envelope around an
 * XML plist, and that plist is readable as plain bytes.
 */
export function profileFacts(file) {
  const raw = readFileSync(file, 'latin1');
  const start = raw.indexOf('<?xml');
  const end = raw.indexOf('</plist>') + '</plist>'.length;
  if (start < 0 || end < start) throw new Error(`${file} holds no plist`);
  const xml = raw.slice(start, end);
  const appId = /<key>application-identifier<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1];
  const expires = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(xml)?.[1];
  if (!appId) throw new Error(`${file} names no application-identifier`);
  return { appId, expires, team: appId.split('.')[0] };
}

/** The repository's entitlements for one target, made acceptable to a development profile. */
export function entitlementsFor(repoFile, facts) {
  let xml = readFileSync(join(APPLE, repoFile), 'utf8');
  xml = xml.replace(/<!DOCTYPE[^>]*>\s*/, '').replace(/<!--[\s\S]*?-->/g, '');
  xml = xml.replaceAll('$(AppIdentifierPrefix)', `${facts.team}.`);
  xml = xml.replace(/(<key>aps-environment<\/key>\s*<string>)production/, '$1development');
  const injected =
    `\t<key>application-identifier</key>\n\t<string>${facts.appId}</string>\n` +
    `\t<key>com.apple.developer.team-identifier</key>\n\t<string>${facts.team}</string>\n` +
    `\t<key>get-task-allow</key>\n\t<true/>\n`;
  const closing = xml.lastIndexOf('</dict>');
  if (closing < 0) throw new Error(`${repoFile} has no top-level dict`);
  return `${xml.slice(0, closing)}${injected}${xml.slice(closing)}`;
}

function bundleId(dir) {
  const code = "import plistlib,sys;print(plistlib.load(open(sys.argv[1],'rb'))['CFBundleIdentifier'])";
  return run('python', ['-c', code, join(dir, 'Info.plist')]).trim();
}

async function main() {
  const args = process.argv.slice(2);
  const ipa = args.find((a) => !a.startsWith('--'));
  if (!ipa) throw new Error('usage: sign-install.mjs <unsigned.ipa> [--no-install]');
  for (const f of ['dev.key', 'dev.pem', 'app.mobileprovision', 'nse.mobileprovision']) {
    if (!existsSync(join(STATE, f))) throw new Error(`missing ${join(STATE, f)}`);
  }
  if (!existsSync(RCODESIGN)) throw new Error(`missing ${RCODESIGN}`);

  const work = mkdtempSync(join(tmpdir(), 'canari-ios-'));
  console.log(`[ios-device] unpacking ${ipa} into ${work}`);
  run(TAR, ['-xf', resolve(ipa), '-C', work]);
  const payload = join(work, 'Payload');
  const app = join(payload, readdirSync(payload).find((n) => n.endsWith('.app')));
  const plugins = join(app, 'PlugIns');
  const appexes = existsSync(plugins) ? readdirSync(plugins).filter((n) => n.endsWith('.appex')) : [];
  if (appexes.length !== 1) throw new Error(`expected exactly one appex in ${plugins}, found ${appexes.length}`);
  const appex = join(plugins, appexes[0]);
  if (existsSync(join(appex, 'Frameworks'))) {
    throw new Error(`${appex}/Frameworks exists - a framework nested in an appex fails verification`);
  }

  const targets = [
    { dir: appex, profile: 'nse.mobileprovision', label: 'notification extension', ent: 'canari_NSE/canari_NSE.entitlements' },
    { dir: app, profile: 'app.mobileprovision', label: 'app', ent: 'canari_iOS/canari_iOS.entitlements' },
  ];
  for (const t of targets) {
    const facts = profileFacts(join(STATE, t.profile));
    const id = bundleId(t.dir);
    if (facts.appId !== `${facts.team}.${id}`) {
      throw new Error(`${t.label} is ${id} but its profile grants ${facts.appId}`);
    }
    console.log(`[ios-device] ${t.label}: ${id}, profile valid until ${facts.expires}`);
    cpSync(join(STATE, t.profile), join(t.dir, 'embedded.mobileprovision'));
    // A RELATIVE PATH FROM `work`, because rcodesign reads `C:\...` as a scope `C` plus a path.
    const entName = `${t.label.replace(/\W/g, '_')}.entitlements.plist`;
    writeFileSync(join(work, entName), entitlementsFor(t.ent, facts));
    run(RCODESIGN, ['sign', '--pem-file', join(STATE, 'dev.key'), '--pem-file', join(STATE, 'dev.pem'), '--entitlements-xml-file', entName, relative(work, t.dir)], work);
    console.log(`[ios-device] signed ${t.label}`);
  }

  const out = `${resolve(ipa).replace(/\.ipa$/i, '')}-signed.ipa`;
  const base = join(work, 'ipa');
  run('python', ['-c', "import shutil,sys;shutil.make_archive(sys.argv[1],'zip',sys.argv[2],'Payload')", base, work]);
  cpSync(`${base}.zip`, out);
  console.log(`[ios-device] wrote ${out}`);
  rmSync(work, { recursive: true, force: true });

  if (args.includes('--no-install')) return;
  await stopRunningApp();
  console.log('[ios-device] installing');
  const inst = spawnSync('python', [join(HERE, 'install.py'), out], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONWARNINGS: 'ignore' },
  });
  const text = `${inst.stdout}${inst.stderr}`;
  console.log(text.split('\n').filter((l) => /Installation succeed|Error|Failed|pushed/.test(l)).join('\n'));
  if (inst.status !== 0 || !/Installation succeeded/.test(text)) process.exit(1);
}

/**
 * Stops the app through the WebDriverAgent daemon. installd leaves an install pending while the
 * app runs, and the daemon is a precondition of this procedure (`wda-daemon.py`), so its absence
 * is an error naming what to start rather than a path that installs anyway and hangs.
 */
async function stopRunningApp() {
  const { wda, session } = await import('./ios.mjs');
  const sid = await session();
  await wda('POST', `/session/${sid}/wda/apps/terminate`, { bundleId: 'fr.emse.canari' });
  console.log('[ios-device] stopped the running app');
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
