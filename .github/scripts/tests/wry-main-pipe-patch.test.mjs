#!/usr/bin/env bun
/**
 * THE VENDORED wry STILL CARRIES THE MAIN-PIPE FIXES PLAY'S REPORTS ASKED FOR.
 *
 * WHAT IS AT RISK. `frontend/src-tauri/patches/wry` is a fork rebased BY HAND whenever upstream
 * releases (`vendored-upstream-report.sh` asks for it). The four `CANARI PATCH` hunks in
 * `src/android/main_pipe.rs` are Android-only and run nowhere in CI: every gate here compiles the
 * Android code and none executes it. So a rebase that takes the new upstream file and forgets a hunk
 * builds, passes, ships - and brings back, silently:
 *   - ANR f51255a5a831e715b4fc8d976e87be11: a BOUNDED channel the main thread both sends into
 *     (`onWebviewDestroy`) and alone drains - a main-thread send into a full channel parks the only
 *     thread that could empty it;
 *   - the same deadlock one step removed: a BLOCKING write to the wake pipe from the main thread;
 *   - crash e3697bc4ad55d069ebb94d3d4a528c34: `get_webview` unwrapping the lookup of an activity that
 *     `OnDestroy` already removed, inside a looper callback that aborts on any panic;
 *   - a drain that unregisters itself for the rest of the process on ONE failed JNI call (`?` in
 *     `recv`), which queues every later message forever.
 * Each is a fact about the SOURCE TEXT, so this reads the text. The device behaviour is owed on real
 * hardware: docs/wiki/device-verification.md#wmp-the-wry-main-pipe-after-an-activity-destroy---owed-on-android.
 *
 * Every predicate is also run against the UPSTREAM shape of the same code, which it must REJECT: a
 * check that cannot fail on the defect it names proves nothing.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const TAURI = join(ROOT, 'frontend', 'src-tauri');
const PIPE = join(TAURI, 'patches', 'wry', 'src', 'android', 'main_pipe.rs');

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`FAIL ${msg}`);
};
const ok = (msg) => console.log(`ok   ${msg}`);

/** The text of one `fn <name>` - from its signature to the first line that closes it at its indent. */
function fnBody(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`\\bfn ${name}\\b`).test(l));
  if (start === -1) return null;
  const indent = lines[start].match(/^\s*/)[0];
  const end = lines.findIndex((l, i) => i > start && l === `${indent}}`);
  return lines.slice(start, end === -1 ? undefined : end + 1).join('\n');
}

/** A top-level `static <name>`, up to the first column-0 line ending in `;` (rustfmt's shape). */
function staticInit(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^(pub )?static ${name}\\b`).test(l));
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i >= start && /^\S.*;\s*$/.test(l));
  return lines.slice(start, end === -1 ? undefined : end + 1).join('\n');
}

const PREDICATES = [
  {
    what: 'the main-thread channel is unbounded',
    holds: (s) => {
      const init = staticInit(s, 'CHANNEL');
      return init !== null && /\bunbounded\b/.test(init) && !/\bbounded\s*\(/.test(init);
    },
    upstream: `static CHANNEL: LazyLock<(
  Sender<(ActivityId, WebViewMessage)>,
  Receiver<(ActivityId, WebViewMessage)>,
)> = LazyLock::new(|| bounded(8));`,
  },
  {
    what: "the wake pipe's write end is made non-blocking",
    holds: (s) => {
      const init = staticInit(s, 'MAIN_PIPE');
      return init !== null && /O_NONBLOCK/.test(init) && /pipe\[1\]/.test(init);
    },
    upstream: `pub static MAIN_PIPE: LazyLock<[OwnedFd; 2]> = LazyLock::new(|| {
  let mut pipe: [RawFd; 2] = Default::default();
  unsafe { libc::pipe(pipe.as_mut_ptr()) };
  unsafe { pipe.map(|fd| OwnedFd::from_raw_fd(fd)) }
});`,
  },
  {
    what: 'get_webview answers None for a destroyed activity instead of unwrapping it',
    holds: (s) => {
      const body = fnBody(s, 'get_webview');
      return body !== null && !/\.get\(&activity_id\)\s*\.unwrap\(\)/.test(body);
    },
    upstream: `pub fn get_webview(activity_id: ActivityId) -> Option<GlobalRef> {
  ACTIVITY_PROXY
    .lock()
    .unwrap()
    .get(&activity_id)
    .unwrap()
    .webview
    .as_ref()
    .cloned()
}`,
  },
  {
    what: 'recv does not propagate one failed message (which would unregister the drain)',
    holds: (s) => {
      const body = fnBody(s, 'recv');
      return (
        body !== null &&
        /handle_message\(/.test(body) &&
        !/handle_message\([^)]*\)\s*\?/.test(body) &&
        /log::error!/.test(body)
      );
    },
    upstream: `  pub fn recv(&mut self) -> JniResult<()> {
    let package = super::PACKAGE.get().unwrap();
    while let Ok((activity_id, message)) = CHANNEL.1.try_recv() {
      self.handle_message(package, activity_id, message)?;
    }
    Ok(())
  }`,
  },
];

let source;
try {
  source = readFileSync(PIPE, 'utf8');
} catch (error) {
  fail(`cannot read ${PIPE} (${error.message}) - the fork is gone or moved; nothing was checked`);
}

if (source !== undefined) {
  for (const p of PREDICATES) {
    if (p.holds(source)) ok(p.what);
    else
      fail(
        `${p.what}: NOT in patches/wry/src/android/main_pipe.rs. A rebase dropped a CANARI PATCH hunk - ` +
          `re-apply it (docs/wiki/frontend/mobile.md#wry-main-pipe-patch).`
      );
    if (p.holds(p.upstream))
      fail(`the check "${p.what}" accepts the UPSTREAM code - it proves nothing`);
  }
}

// The patch only applies while the manifest routes wry to the fork AND pins the fork's version.
const manifest = readFileSync(join(TAURI, 'Cargo.toml'), 'utf8');
if (/^wry\s*=\s*\{\s*path\s*=\s*"patches\/wry"\s*\}/m.test(manifest))
  ok('[patch.crates-io] routes wry to the fork');
else
  fail(
    'frontend/src-tauri/Cargo.toml no longer patches wry from patches/wry - the fixes do not ship'
  );

console.log(failures === 0 ? '\nall wry main-pipe checks hold' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
